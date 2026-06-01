import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  KimiHarness,
  type Event,
  type PermissionMode,
  type PromptInput,
  type SessionStatus,
  type SessionSummary,
} from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeHostIdentity } from './version';

const PROTOCOL_VERSION = '1.0';
const SDK_SERVER_UI_MODE = 'sdk-server';
const MAIN_AGENT_ID = 'main';
const TURN_START_TIMEOUT_MS = 5_000;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface ResolvedCreateSessionParams {
  readonly id?: string;
  readonly workDir: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: PermissionMode;
  readonly metadata?: Record<string, unknown>;
}

interface PromptParams {
  readonly sessionId: string;
  readonly input: string | PromptInput;
}

interface ResumeSessionParams {
  readonly id: string;
}

interface ListSessionsParams {
  readonly workDir?: string;
  readonly sessionId?: string;
}

interface CancelParams {
  readonly sessionId: string;
  readonly turnId?: number;
}

interface SdkServerSession {
  readonly id: string;
  readonly workDir: string;
  readonly summary?: SessionSummary;
  onEvent(listener: (event: Event) => void): () => void;
  prompt(input: string | PromptInput): Promise<void>;
  steer(input: string | PromptInput): Promise<void>;
  cancel(): Promise<void>;
  getStatus(): Promise<SessionStatus>;
  close(): Promise<void>;
}

interface SdkServerHarness {
  createSession(options: ResolvedCreateSessionParams): Promise<SdkServerSession>;
  resumeSession(input: ResumeSessionParams): Promise<SdkServerSession>;
  closeSession(id: string): Promise<void>;
  listSessions(options?: ListSessionsParams): Promise<readonly SessionSummary[]>;
  close(): Promise<void>;
}

interface SdkServerOptions {
  readonly version: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly harness?: SdkServerHarness;
  readonly createHarness?: (() => SdkServerHarness);
}

interface ActiveTurn {
  readonly promise: Promise<number>;
  resolve(turnId: number): void;
}

export async function runSdkServer(options: SdkServerOptions): Promise<void> {
  const server = new SdkServer({
    version: options.version,
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    harness:
      options.harness ??
      options.createHarness?.() ??
      new KimiHarness({
        identity: createKimiCodeHostIdentity(options.version),
        uiMode: SDK_SERVER_UI_MODE,
      }),
  });
  await server.run();
}

class SdkServer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly harness: SdkServerHarness;
  private readonly version: string;
  private readonly sessions = new Map<
    string,
    { readonly session: SdkServerSession; readonly unsubscribe: () => void }
  >();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private initialized = false;
  private shuttingDown = false;

  constructor(options: Required<Pick<SdkServerOptions, 'version'>> & {
    readonly input: Readable;
    readonly output: Writable;
    readonly harness: SdkServerHarness;
  }) {
    this.input = options.input;
    this.output = options.output;
    this.harness = options.harness;
    this.version = options.version;
  }

  async run(): Promise<void> {
    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        await this.handleLine(line);
        if (this.shuttingDown) break;
      }
    } finally {
      await this.shutdown();
    }
  }

  private async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = parseRequest(line);
    } catch (error) {
      this.writeError(null, toProtocolError(error));
      return;
    }

    try {
      if (!this.initialized && request.method !== 'initialize') {
        throw new ProtocolError('INVALID_REQUEST', 'initialize must be called first.');
      }
      const result = await this.handleRequest(request.method, request.params);
      if (request.id !== undefined) {
        this.writeResponse(request.id, result);
      }
    } catch (error) {
      if (request.id !== undefined) {
        this.writeError(request.id, toProtocolError(error));
      }
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'createSession':
        return this.createSession(params);
      case 'resumeSession':
        return this.resumeSession(params);
      case 'closeSession':
        return this.closeSession(params);
      case 'prompt':
        return this.prompt(params);
      case 'steer':
        return this.steer(params);
      case 'cancel':
        return this.cancel(params);
      case 'getStatus':
        return this.getStatus(params);
      case 'listSessions':
        return this.listSessions(params);
      case 'shutdown':
        this.shuttingDown = true;
        return {};
      default:
        throw new ProtocolError('INVALID_REQUEST', `Unknown method: ${method}`);
    }
  }

  private initialize(params: unknown): unknown {
    const input = asRecord(params, 'initialize params');
    const supportedVersions = asStringArray(input['supportedVersions'], 'supportedVersions');
    if (!supportedVersions.includes(PROTOCOL_VERSION)) {
      throw new ProtocolError(
        'UNSUPPORTED_PROTOCOL_VERSION',
        `Supported protocol versions: ${PROTOCOL_VERSION}`,
        false,
        { supportedVersions: [PROTOCOL_VERSION] },
      );
    }
    this.initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      supportedVersions: [PROTOCOL_VERSION],
      server: {
        name: 'kimi-code',
        version: this.version,
      },
      capabilities: {},
    };
  }

  private async createSession(params: unknown): Promise<SessionSummary> {
    const input = normalizeCreateSessionParams(params);
    const session = await this.harness.createSession(input);
    this.registerSession(session);
    return session.summary ?? sessionToSummary(session);
  }

  private async resumeSession(params: unknown): Promise<SessionSummary> {
    const input = asRecord(params, 'resumeSession params');
    const id = requiredString(input['id'], 'id');
    const session = await this.harness.resumeSession({ id });
    this.registerSession(session);
    return session.summary ?? sessionToSummary(session);
  }

  private async closeSession(params: unknown): Promise<Record<string, never>> {
    const input = asRecord(params, 'closeSession params');
    const sessionId = requiredString(input['sessionId'], 'sessionId');
    const registered = this.sessions.get(sessionId);
    registered?.unsubscribe();
    this.sessions.delete(sessionId);
    this.activeTurns.delete(sessionId);
    await this.harness.closeSession(sessionId);
    return {};
  }

  private async prompt(params: unknown): Promise<{ turnId: number }> {
    const input = normalizePromptParams(params);
    const session = this.requireSession(input.sessionId);
    if (this.activeTurns.has(input.sessionId)) {
      throw new ProtocolError('TURN_ALREADY_ACTIVE', 'A turn is already active for this session.');
    }
    const activeTurn = createActiveTurn();
    this.activeTurns.set(input.sessionId, activeTurn);
    try {
      const accepted = session.prompt(input.input);
      const turnId = await waitForTurnStart(activeTurn.promise, accepted);
      return { turnId };
    } catch (error) {
      this.activeTurns.delete(input.sessionId);
      throw error;
    }
  }

  private async steer(params: unknown): Promise<Record<string, never>> {
    const input = normalizePromptParams(params);
    const session = this.requireSession(input.sessionId);
    if (!this.activeTurns.has(input.sessionId)) {
      throw new ProtocolError('TURN_NOT_ACTIVE', 'No active turn for this session.');
    }
    await session.steer(input.input);
    return {};
  }

  private async cancel(params: unknown): Promise<Record<string, never>> {
    const input = normalizeCancelParams(params);
    const session = this.requireSession(input.sessionId);
    if (!this.activeTurns.has(input.sessionId)) {
      throw new ProtocolError('TURN_NOT_ACTIVE', 'No active turn for this session.');
    }
    await session.cancel();
    return {};
  }

  private async getStatus(params: unknown): Promise<SessionStatus> {
    const input = asRecord(params, 'getStatus params');
    const sessionId = requiredString(input['sessionId'], 'sessionId');
    return this.requireSession(sessionId).getStatus();
  }

  private async listSessions(params: unknown): Promise<readonly SessionSummary[]> {
    const input = params === undefined ? {} : normalizeListSessionsParams(params);
    return this.harness.listSessions(input);
  }

  private registerSession(session: SdkServerSession): void {
    this.sessions.get(session.id)?.unsubscribe();
    const unsubscribe = session.onEvent((event) => {
      this.handleSessionEvent(session.id, event);
    });
    this.sessions.set(session.id, { session, unsubscribe });
  }

  private handleSessionEvent(sessionId: string, event: Event): void {
    const activeTurn = this.activeTurns.get(sessionId);
    if (event.type === 'turn.started') {
      activeTurn?.resolve(event.turnId);
    }
    if (event.type === 'turn.ended') {
      this.activeTurns.delete(sessionId);
    }
    this.writeNotification('event', withSdkEventEnvelope(sessionId, event));
  }

  private requireSession(sessionId: string): SdkServerSession {
    const session = this.sessions.get(sessionId)?.session;
    if (session === undefined) {
      throw new ProtocolError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
    return session;
  }

  private async shutdown(): Promise<void> {
    for (const { unsubscribe } of this.sessions.values()) {
      unsubscribe();
    }
    this.sessions.clear();
    this.activeTurns.clear();
    await this.harness.close();
  }

  private writeNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private writeResponse(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private writeError(id: JsonRpcId, error: ProtocolError): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error: {
        code: error.code,
        message: error.message,
        data: {
          retryable: error.retryable,
          details: error.details,
        },
      },
    });
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}

class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function parseRequest(line: string): JsonRpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new ProtocolError('INVALID_REQUEST', 'Malformed JSON-RPC message.');
  }
  const record = asRecord(value, 'JSON-RPC message');
  if (record['jsonrpc'] !== '2.0') {
    throw new ProtocolError('INVALID_REQUEST', 'jsonrpc must be "2.0".');
  }
  const method = requiredString(record['method'], 'method');
  const id = record['id'];
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number' && id !== null) {
    throw new ProtocolError('INVALID_REQUEST', 'id must be string, number, or null.');
  }
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: record['params'],
  };
}

function normalizeCreateSessionParams(params: unknown): ResolvedCreateSessionParams {
  const input = asRecord(params, 'createSession params');
  const thinking = input['thinking'];
  return {
    id: optionalString(input['id'], 'id'),
    workDir: requiredString(input['workDir'], 'workDir'),
    model: optionalString(input['model'], 'model'),
    thinking:
      typeof thinking === 'boolean'
        ? thinking
          ? 'on'
          : 'off'
        : optionalString(thinking, 'thinking'),
    permission: optionalPermission(input['permission']),
    metadata: optionalRecord(input['metadata'], 'metadata'),
  };
}

function normalizePromptParams(params: unknown): PromptParams {
  const input = asRecord(params, 'prompt params');
  return {
    sessionId: requiredString(input['sessionId'], 'sessionId'),
    input: normalizePromptInput(input['input']),
  };
}

function normalizeCancelParams(params: unknown): CancelParams {
  const input = asRecord(params, 'cancel params');
  const turnId = input['turnId'];
  return {
    sessionId: requiredString(input['sessionId'], 'sessionId'),
    turnId: turnId === undefined ? undefined : requiredNumber(turnId, 'turnId'),
  };
}

function normalizeListSessionsParams(params: unknown): ListSessionsParams {
  const input = asRecord(params, 'listSessions params');
  return {
    workDir: optionalString(input['workDir'], 'workDir'),
    sessionId: optionalString(input['sessionId'], 'sessionId'),
  };
}

function normalizePromptInput(input: unknown): string | PromptInput {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) {
    throw new ProtocolError('INVALID_INPUT', 'prompt input must be a string or array.');
  }
  return input.map((part, index) => normalizePromptPart(part, index));
}

function normalizePromptPart(part: unknown, index: number): PromptInput[number] {
  const input = asRecord(part, `prompt part ${index}`);
  switch (input['type']) {
    case 'text':
      return { type: 'text', text: requiredString(input['text'], `prompt part ${index}.text`) };
    case 'image_url':
      return {
        type: 'image_url',
        imageUrl: normalizeUrlPart(input['image_url'] ?? input['imageUrl'], index, 'image_url'),
      };
    case 'video_url':
      return {
        type: 'video_url',
        videoUrl: normalizeUrlPart(input['video_url'] ?? input['videoUrl'], index, 'video_url'),
      };
    default:
      throw new ProtocolError(
        'INVALID_INPUT',
        `Unsupported prompt part type at index ${index}.`,
      );
  }
}

function normalizeUrlPart(value: unknown, index: number, field: string): { url: string } {
  const input = asRecord(value, `prompt part ${index}.${field}`);
  return { url: requiredString(input['url'], `prompt part ${index}.${field}.url`) };
}

function withSdkEventEnvelope(sessionId: string, event: Event): Record<string, unknown> {
  const raw = event as unknown as Record<string, unknown>;
  return {
    ...raw,
    sessionId,
    agentId: typeof raw['agentId'] === 'string' ? raw['agentId'] : MAIN_AGENT_ID,
  };
}

function createActiveTurn(): ActiveTurn {
  let resolve!: (turnId: number) => void;
  const promise = new Promise<number>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitForTurnStart(turnStarted: Promise<number>, accepted: Promise<void>): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ProtocolError('SERVER_ERROR', 'Timed out waiting for turn.started.'));
    }, TURN_START_TIMEOUT_MS);
  });
  const acceptedDone = accepted.then(
    () => {
      throw new ProtocolError('SERVER_ERROR', 'Prompt resolved before turn.started.');
    },
    (error: unknown) => {
      throw error;
    },
  );
  try {
    return await Promise.race([turnStarted, acceptedDone, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function sessionToSummary(session: SdkServerSession): SessionSummary {
  return {
    id: session.id,
    workDir: session.workDir,
    sessionDir: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (isRecord(error) && typeof error['code'] === 'string') {
    return new ProtocolError(
      mapKimiErrorCode(error['code']),
      errorMessage(error),
      false,
      error,
    );
  }
  return new ProtocolError('SERVER_ERROR', errorMessage(error));
}

function mapKimiErrorCode(code: string): string {
  switch (code) {
    case 'session.closed':
      return 'SESSION_CLOSED';
    case 'session.not_found':
      return 'SESSION_NOT_FOUND';
    default:
      return 'SERVER_ERROR';
  }
}

function optionalPermission(value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'manual' || value === 'auto' || value === 'yolo') return value;
  throw new ProtocolError('INVALID_INPUT', 'permission must be manual, auto, or yolo.');
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError('INVALID_INPUT', `${field} must be a non-empty string.`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('INVALID_INPUT', `${field} must be an integer.`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new ProtocolError('INVALID_INPUT', `${field} must be an array of strings.`);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return asRecord(value, field);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolError('INVALID_INPUT', `${field} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
