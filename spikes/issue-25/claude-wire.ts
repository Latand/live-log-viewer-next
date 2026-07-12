export type EngineEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
  model?: string;
  result?: string;
  event?: { type?: string };
  [key: string]: unknown;
};

export type BrokerMessage = {
  kind?: string;
  active?: boolean;
  sessionId?: string;
  lastSeq?: number;
  replay?: Array<{ seq: number; value: EngineEvent }>;
  seq?: number;
  event?: EngineEvent;
  clientMessageId?: string;
  disposition?: string;
  [key: string]: unknown;
};
