export interface Plan {
  kind: 'isolate' | 'hide';
  keepId: string | null;
  targetIds: string[];
  reasoning: string;
}
