/** Fields inspected by the native permission integration checks. */
export interface HookInput {
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: {
    command?: string;
    file_path?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
  };
  permission_mode: string;
  hook_event_name?: string;
  transcript_path?: string;
}

export interface TranscriptEntry {
  type: string;
  message?: {
    model?: string;
    stop_reason?: string;
    content?: string | TranscriptBlock[];
  };
}

export interface TranscriptBlock {
  type: string;
  id?: string;
  name?: string;
  input?: HookInput['tool_input'];
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
