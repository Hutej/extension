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
  op: 'hide' | 'isolate' | 'act';
  targetId?: string;
  keepId?: string;
  action?: ActionSpec;
}

export interface Plan {
  operations: Operation[];
  reasoning: string;
}
