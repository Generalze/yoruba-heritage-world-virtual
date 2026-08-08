/** Display labels for the controlled Step 7 content types. UI labels
 * only — machine codes stay authoritative everywhere else. */
export const CONTENT_TYPE_LABELS: Record<string, string> = {
  PREPARATION: 'Preparation',
  WHAT_TO_EXPECT: 'What to Expect',
  ARRIVAL_GUIDANCE: 'Arrival Guidance',
  PRAYER_PREPARATION: 'Prayer Preparation',
  POST_SESSION_GUIDANCE: 'Post-Session Guidance',
  THANKSGIVING_GUIDANCE: 'Thanksgiving Guidance',
  GENERAL_SPIRITUAL_NOTICE: 'Important Spiritual Notice',
}

export const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  yo: 'Yorùbá',
}

export function contentTypeLabel(code: string): string {
  return CONTENT_TYPE_LABELS[code] ?? code
}
