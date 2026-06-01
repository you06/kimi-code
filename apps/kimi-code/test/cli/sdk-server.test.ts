import { PassThrough, Readable, Writable } from 'node:stream';

import type { Event, PromptInput, SessionStatus, SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { runSdkServer } from '#/cli/sdk-server';

class CapturingWritable extends Writable {
  readonly chunks: string[] = [];
  private readonly waiters = new Set<() => void>();

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    for (const waiter of this.waiters) {
      waiter();
    }
    callback();
  }

  messages(): unknown[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }

  async waitFor(predicate: (message: unknown) => boolean): Promise<unknown> {
    const existing = this.messages().find(predicate);
    if (existing !== undefined) return existing;

    return new Promise((resolve) => {
      const notify = () => {
        const message = this.messages().find(predicate);
        if (message === undefined) return;
        this.waiters.delete(notify);
        resolve(message);
      };
      this.waiters.add(notify);
    });
  }
}

class FakeSession {
  readonly id: string;
  readonly workDir: string;
  readonly summary: SessionSummary;
  readonly promptInputs: Array<string | PromptInput> = [];
  protected readonly listeners = new Set<(event: Event) => void>();
  protected nextTurnId = 0;

  constructor(summary: SessionSummary) {
    this.id = summary.id;
    this.workDir = summary.workDir;
    this.summary = summary;
  }

  onEvent(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(input: string | PromptInput): Promise<void> {
    this.promptInputs.push(input);
    const turnId = this.nextTurnId;
    this.nextTurnId += 1;
    this.emit({
      type: 'turn.started',
      sessionId: this.id,
      agentId: 'main',
      turnId,
      origin: { kind: 'user' },
    });
    this.emit({
      type: 'assistant.delta',
      sessionId: this.id,
      agentId: 'main',
      turnId,
      delta: 'hello from fake sdk server',
    });
    this.emit({
      type: 'turn.ended',
      sessionId: this.id,
      agentId: 'main',
      turnId,
      reason: 'completed',
    });
  }

  async steer(input: string | PromptInput): Promise<void> {
    this.promptInputs.push(input);
  }

  async cancel(): Promise<void> {}

  async getStatus(): Promise<SessionStatus> {
    return {
      thinkingLevel: 'off',
      permission: 'auto',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
    };
  }

  async close(): Promise<void> {}

  protected emit(event: Event): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeHarness {
  readonly sessions = new Map<string, FakeSession>();
  readonly createInputs: unknown[] = [];
  closed = false;

  constructor(
    private readonly createFakeSession: (summary: SessionSummary) => FakeSession = (summary) =>
      new FakeSession(summary),
  ) {}

  async createSession(input: {
    readonly id?: string;
    readonly workDir: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly permission?: string;
  }): Promise<FakeSession> {
    this.createInputs.push(input);
    const summary: SessionSummary = {
      id: input.id ?? 'ses_fake',
      workDir: input.workDir,
      sessionDir: `${input.workDir}/.kimi-code/sessions/ses_fake`,
      createdAt: 1,
      updatedAt: 2,
    };
    const session = this.createFakeSession(summary);
    this.sessions.set(summary.id, session);
    return session;
  }

  async resumeSession(input: { readonly id: string }): Promise<FakeSession> {
    const session = this.sessions.get(input.id);
    if (session === undefined) throw new Error(`missing session ${input.id}`);
    return session;
  }

  async closeSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return Array.from(this.sessions.values(), (session) => session.summary);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class DelayedPromptSession extends FakeSession {
  override async prompt(input: string | PromptInput): Promise<void> {
    this.promptInputs.push(input);
    const turnId = this.nextTurnId;
    this.nextTurnId += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.emit({
      type: 'turn.started',
      sessionId: this.id,
      agentId: 'main',
      turnId,
      origin: { kind: 'user' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    this.emit({
      type: 'assistant.delta',
      sessionId: this.id,
      agentId: 'main',
      turnId,
      delta: 'hello after prompt response',
    });
    this.emit({
      type: 'turn.ended',
      sessionId: this.id,
      agentId: 'main',
      turnId,
      reason: 'completed',
    });
  }
}

function writeJson(input: PassThrough, message: unknown): void {
  input.write(`${JSON.stringify(message)}\n`);
}

function isResponse(message: unknown, id: string): boolean {
  return isMessageRecord(message) && message['id'] === id;
}

function isEvent(message: unknown, type: string): boolean {
  return (
    isMessageRecord(message) &&
    message['method'] === 'event' &&
    isMessageRecord(message['params']) &&
    message['params']['type'] === type
  );
}

function isMessageRecord(message: unknown): message is Record<string, unknown> {
  return typeof message === 'object' && message !== null && !Array.isArray(message);
}

describe('sdk-server stdio protocol', () => {
  it('initializes, creates a session, streams prompt events, and shuts down', async () => {
    const harness = new FakeHarness();
    const output = new CapturingWritable();
    const input = Readable.from(
      [
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'initialize',
          params: { supportedVersions: ['1.0'], client: { name: 'test' } },
        },
        {
          jsonrpc: '2.0',
          id: '2',
          method: 'createSession',
          params: {
            id: 'ses_fake',
            workDir: '/tmp/project',
            model: 'fake-model',
            thinking: false,
            permission: 'auto',
          },
        },
        {
          jsonrpc: '2.0',
          id: '3',
          method: 'prompt',
          params: { sessionId: 'ses_fake', input: 'hello' },
        },
        { jsonrpc: '2.0', id: '4', method: 'shutdown', params: {} },
      ].map((message) => `${JSON.stringify(message)}\n`),
    );

    await runSdkServer({ version: '0.0.0-test', input, output, harness });

    expect(harness.closed).toBe(true);
    expect(harness.createInputs).toContainEqual(
      expect.objectContaining({
        workDir: '/tmp/project',
        model: 'fake-model',
        thinking: 'off',
        permission: 'auto',
      }),
    );
    expect(harness.sessions.get('ses_fake')?.promptInputs).toContain('hello');

    const messages = output.messages();
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: '1',
        result: expect.objectContaining({
          protocolVersion: '1.0',
          server: { name: 'kimi-code', version: '0.0.0-test' },
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: '2',
        result: expect.objectContaining({ id: 'ses_fake', workDir: '/tmp/project' }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: 'event',
        params: expect.objectContaining({
          type: 'assistant.delta',
          sessionId: 'ses_fake',
          agentId: 'main',
          turnId: 0,
          delta: 'hello from fake sdk server',
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: '3',
        result: { turnId: 0 },
      }),
    );
    expect(messages).toContainEqual(expect.objectContaining({ id: '4', result: {} }));
  });

  it('rejects unsupported protocol versions with a string protocol error code', async () => {
    const output = new CapturingWritable();
    const input = Readable.from([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: { supportedVersions: ['9.9'] },
      })}\n`,
    ]);

    await runSdkServer({ version: '0.0.0-test', input, output, harness: new FakeHarness() });

    expect(output.messages()).toContainEqual(
      expect.objectContaining({
        id: '1',
        error: expect.objectContaining({
          code: 'UNSUPPORTED_PROTOCOL_VERSION',
          message: 'Supported protocol versions: 1.0',
        }),
      }),
    );
  });

  it('responds to prompt after turn.started without waiting for the whole turn', async () => {
    const harness = new FakeHarness((summary) => new DelayedPromptSession(summary));
    const output = new CapturingWritable();
    const input = new PassThrough();
    const serverDone = runSdkServer({ version: '0.0.0-test', input, output, harness });

    writeJson(input, {
      jsonrpc: '2.0',
      id: '1',
      method: 'initialize',
      params: { supportedVersions: ['1.0'] },
    });
    await output.waitFor((message) => isResponse(message, '1'));

    writeJson(input, {
      jsonrpc: '2.0',
      id: '2',
      method: 'createSession',
      params: { id: 'ses_fake', workDir: '/tmp/project' },
    });
    await output.waitFor((message) => isResponse(message, '2'));

    writeJson(input, {
      jsonrpc: '2.0',
      id: '3',
      method: 'prompt',
      params: { sessionId: 'ses_fake', input: 'hello' },
    });
    await output.waitFor((message) => isResponse(message, '3'));
    await output.waitFor((message) => isEvent(message, 'turn.ended'));

    const messages = output.messages();
    const turnStartedIndex = messages.findIndex((message) => isEvent(message, 'turn.started'));
    const promptResponseIndex = messages.findIndex((message) => isResponse(message, '3'));
    const turnEndedIndex = messages.findIndex((message) => isEvent(message, 'turn.ended'));

    expect(turnStartedIndex).toBeGreaterThan(-1);
    expect(promptResponseIndex).toBeGreaterThan(turnStartedIndex);
    expect(turnEndedIndex).toBeGreaterThan(promptResponseIndex);

    writeJson(input, { jsonrpc: '2.0', id: '4', method: 'shutdown', params: {} });
    input.end();
    await serverDone;
  });
});
