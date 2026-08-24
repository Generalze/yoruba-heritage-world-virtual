import { useState } from 'react'

import type { WorkflowEvent } from '@/services/admin-catalogue'

/** Shared building blocks for the admin catalogue UI. */

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'border border-line-strong bg-surface text-ink-soft',
  UNDER_REVIEW: 'border border-caution/40 bg-caution/10 text-caution',
  APPROVED: 'border border-gold bg-gold/10 text-gold-deep',
  PUBLISHED: 'border border-affirm/40 bg-affirm/10 text-affirm',
  ARCHIVED: 'border border-line bg-surface text-ink-soft',
}

export function StatusBadge(props: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
        STATUS_STYLES[props.status] ??
        'border border-line-strong bg-surface text-ink-soft'
      }`}
    >
      {props.status.replace('_', ' ')}
    </span>
  )
}

const EVENT_LABELS: Record<WorkflowEvent, string> = {
  submit: 'Submit for review',
  approve: 'Approve',
  reject: 'Return to draft',
  publish: 'Publish',
  unpublish: 'Unpublish',
  archive: 'Archive',
  restore: 'Restore to draft',
}

/**
 * Workflow buttons for the events the current user's permissions allow.
 * "Return to draft" requires a review note; a small inline form
 * collects it. Server-side permission checks remain the real boundary.
 */
export function WorkflowActions(props: {
  events: Array<WorkflowEvent>
  busy: boolean
  onEvent: (event: WorkflowEvent, note?: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')

  if (props.events.length === 0) return null

  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap gap-2">
        {props.events.map((event) =>
          event === 'reject' ? (
            <button
              key={event}
              type="button"
              disabled={props.busy}
              onClick={() => setRejecting((value) => !value)}
              className="rounded-md border border-alert/40 px-3 py-1.5 text-sm text-alert hover:border-alert disabled:opacity-50"
            >
              {EVENT_LABELS[event]}
            </button>
          ) : (
            <button
              key={event}
              type="button"
              disabled={props.busy}
              onClick={() => props.onEvent(event)}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink hover:border-gold-deep hover:text-gold-deep disabled:opacity-50"
            >
              {EVENT_LABELS[event]}
            </button>
          ),
        )}
      </div>
      {rejecting ? (
        <div className="rounded-md border border-alert/40 bg-alert/10 p-3">
          <label className="block text-sm text-alert">
            Reason for returning this record
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              rows={2}
              className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
            />
          </label>
          <button
            type="button"
            disabled={props.busy || note.trim().length === 0}
            onClick={() => {
              props.onEvent('reject', note.trim())
              setRejecting(false)
              setNote('')
            }}
            className="mt-2 rounded-md bg-alert px-3 py-1.5 text-sm text-white hover:bg-alert/90 disabled:opacity-50"
          >
            Confirm return to draft
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function AdminField(props: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-soft">
        {props.label}
      </span>
      {props.children}
    </label>
  )
}

export const adminInputClass =
  'w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-ink focus:border-gold-deep focus:outline-none'

export function AdminError(props: { message: string | null }) {
  if (!props.message) return null
  return (
    <p
      role="alert"
      className="mt-3 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert"
    >
      {props.message}
    </p>
  )
}
