// The datamine event server's protocol v1, under the explorer's own names.
import type {
  s_events_server_entry,
  s_events_server_hello,
  s_events_server_parameter,
  s_events_server_session,
} from "@blamnetwork/datamine/reading";

export type ServerParameter = s_events_server_parameter;
export type ServerHello = s_events_server_hello;
export type ServerEntry = s_events_server_entry;
export type ServerSession = s_events_server_session;
