export interface ActionSpec {
  type: string;
  targetId?: string;
  scope?: string;
  maxClicks?: number;
  key?: string;
  do?: InnerAction;
}

export interface InnerAction {
  type: 'clickTarget' | 'scrollToTarget';
  targetId: string;
}

export interface Operation {
  op: 'hide' | 'act';
  targetId?: string;
  action?: ActionSpec;
}

export interface Plan {
  mode: 'isolate' | 'edit';
  keepId: string | null;
  operations: Operation[];
  reasoning: string;
}
