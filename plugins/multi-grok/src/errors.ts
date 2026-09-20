/**
 * Turns a native failure into one actionable sentence. The CLI reports an expired
 * browser credential, a missing session and an unusable policy in prose, and each
 * needs a different move from the user.
 */
const ADVICE: readonly { match: RegExp; advice: string }[] = [
  {
    match: /not authenticated|unauthorized|401|sign in|log ?in again|token (?:has )?expired/i,
    advice: 'Run grok login in your own terminal; the browser credential expires weekly.',
  },
  {
    match: /session .*(?:not found|does not exist|unknown)|no such session/i,
    advice:
      'The native session is gone. Start a new worker conversation; Multi never rewinds native state.',
  },
  {
    match: /did not apply the session tool policy|unknown tool prefix|invalid value .*permission/i,
    advice: 'This Grok build does not enforce the requested policy. Update grok, then retry.',
  },
  {
    match: /rate limit|quota|too many requests|429/i,
    advice: 'The Grok subscription is rate limited. Wait for the window to reset or switch models.',
  },
  {
    match: /ENOENT|not recognized|command not found/i,
    advice: 'Install Grok Build and make grok available on PATH.',
  },
];

export function grokFailureAdvice(message: string): string | undefined {
  return ADVICE.find(({ match }) => match.test(message))?.advice;
}
