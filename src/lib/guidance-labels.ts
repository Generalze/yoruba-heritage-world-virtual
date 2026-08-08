/** Display labels for the controlled content types (Step 7 guidance +
 * Step 8 sacred runtime). UI labels only — machine codes stay
 * authoritative everywhere else. */
export const CONTENT_TYPE_LABELS: Record<string, string> = {
  PREPARATION: 'Preparation',
  WHAT_TO_EXPECT: 'What to Expect',
  ARRIVAL_GUIDANCE: 'Arrival Guidance',
  PRAYER_PREPARATION: 'Prayer Preparation',
  POST_SESSION_GUIDANCE: 'Post-Session Guidance',
  THANKSGIVING_GUIDANCE: 'Thanksgiving Guidance',
  GENERAL_SPIRITUAL_NOTICE: 'Important Spiritual Notice',
  OPENING: 'Opening',
  GREETING: 'Greeting',
  HOUSE_INTRO: 'House Introduction',
  INVOCATION: 'Invocation',
  PRAYER: 'Prayer',
  CALL_RESPONSE: 'Call & Response',
  REFLECTION: 'Reflection',
  CHANT: 'Chant',
  BLESSING: 'Blessing',
  CLOSING: 'Closing',
}

export const RIGHTS_STATUS_LABELS: Record<string, string> = {
  UNREVIEWED: 'Unreviewed',
  PENDING_REVIEW: 'Pending Review',
  CLEARED: 'Cleared',
  RESTRICTED: 'Restricted',
  WITHDRAWN: 'Withdrawn',
}

export const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  yo: 'Yorùbá',
}

export function contentTypeLabel(code: string): string {
  return CONTENT_TYPE_LABELS[code] ?? code
}
