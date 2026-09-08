//native

import * as wmill from "windmill-client";

export type RuleMessage = {
  title: string;
  description: string;
};

export type MonitorOutput = {
  matched: boolean;
  message?: RuleMessage;
  fields: Record<string, unknown>;
};

export type MonitorState<
  Inputs extends Record<string, unknown> = Record<string, unknown>,
  States extends Record<string, unknown> = Record<string, unknown>,
  Outputs extends MonitorOutput = MonitorOutput,
> = {
  inputs: Inputs;
  states: States;
  outputs: Outputs;
};

export type RootJob = {
  script_path?: string;
};

export type RootJobReader = {
  getRootJobId(): Promise<string>;
  getJob(jobId: string): Promise<RootJob>;
};

const WINDMILL_PATH = /^[fug]\/[A-Za-z0-9_./-]+$/;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function monitorStatePath(rootFlowPath: string): string {
  if (typeof rootFlowPath !== "string" || !WINDMILL_PATH.test(rootFlowPath)) {
    throw new Error("root Flow path must be a Windmill path under f/, u/, or g/");
  }
  return `${rootFlowPath}/__monitor_state`;
}

export async function resolveRootFlowPath(reader: RootJobReader): Promise<string> {
  const rootJobId = await reader.getRootJobId();
  const rootJob = await reader.getJob(rootJobId);
  if (!rootJob.script_path) throw new Error("root job does not have a Flow path");
  monitorStatePath(rootJob.script_path);
  return rootJob.script_path;
}

export function emptyMonitorState(): MonitorState {
  return { inputs: {}, states: {}, outputs: { matched: false, fields: {} } };
}

export function normalizeMonitorOutput(value: unknown): MonitorOutput {
  assertRecord(value, "MonitorOutput");
  const unknownField = Object.keys(value).find(
    (field) => !["matched", "message", "fields"].includes(field),
  );
  if (unknownField) {
    throw new Error(`MonitorOutput.${unknownField} is not supported`);
  }
  if (typeof value.matched !== "boolean") {
    throw new Error("MonitorOutput.matched must be a boolean");
  }
  assertRecord(value.fields, "MonitorOutput.fields");
  if (value.message !== undefined) {
    assertRecord(value.message, "MonitorOutput.message");
    const unknownMessageField = Object.keys(value.message).find(
      (field) => !["title", "description"].includes(field),
    );
    if (unknownMessageField) {
      throw new Error(`MonitorOutput.message.${unknownMessageField} is not supported`);
    }
    if (typeof value.message.title !== "string" || !value.message.title.trim()) {
      throw new Error("MonitorOutput.message.title must be a non-empty string");
    }
    if (
      typeof value.message.description !== "string"
      || !value.message.description.trim()
    ) {
      throw new Error("MonitorOutput.message.description must be a non-empty string");
    }
  }
  return structuredClone(value) as MonitorOutput;
}

export function normalizeMonitorState(value: unknown): MonitorState {
  assertRecord(value, "MonitorState");
  assertRecord(value.inputs, "MonitorState.inputs");
  assertRecord(value.states, "MonitorState.states");
  normalizeMonitorOutput(value.outputs);
  return structuredClone(value) as MonitorState;
}

export function createMonitorState<
  Inputs extends Record<string, unknown>,
  States extends Record<string, unknown>,
  Outputs extends MonitorOutput,
>(
  inputs: Inputs,
  states: States,
  outputs: Outputs,
): MonitorState<Inputs, States, Outputs> {
  return normalizeMonitorState({ inputs, states, outputs }) as MonitorState<
    Inputs,
    States,
    Outputs
  >;
}

async function currentMonitorStatePath(): Promise<string> {
  const workspace = process.env.WM_WORKSPACE;
  if (!workspace) throw new Error("WM_WORKSPACE is not set");

  const rootFlowPath = await resolveRootFlowPath({
    getRootJobId: () => wmill.getRootJobId(),
    getJob: (id) => wmill.JobService.getJob({
      workspace,
      id,
      noCode: true,
      noLogs: true,
    }),
  });
  return monitorStatePath(rootFlowPath);
}

export async function getMonitorState<
  Inputs extends Record<string, unknown> = Record<string, unknown>,
  States extends Record<string, unknown> = Record<string, unknown>,
  Outputs extends MonitorOutput = MonitorOutput,
>(): Promise<MonitorState<Inputs, States, Outputs>> {
  const stored = await wmill.getResource(await currentMonitorStatePath(), true);
  const state = stored === undefined ? emptyMonitorState() : normalizeMonitorState(stored);
  return state as MonitorState<Inputs, States, Outputs>;
}

export async function setMonitorState<
  Inputs extends Record<string, unknown>,
  States extends Record<string, unknown>,
  Outputs extends MonitorOutput,
>(
  inputs: Inputs,
  states: States,
  outputs: Outputs,
): Promise<MonitorState<Inputs, States, Outputs>> {
  const monitorState = createMonitorState(inputs, states, outputs);
  await wmill.setResource(monitorState, await currentMonitorStatePath(), "monitor_state");
  return monitorState;
}
