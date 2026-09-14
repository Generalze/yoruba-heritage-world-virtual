import { createFileRoute } from '@tanstack/react-router'

import { AdminHelpPanel } from '@/components/admin'
import { CONSENT_VERSIONS, REQUIRED_CONSENT_TYPES } from '@/lib/consent-policy'
import {
  SPIRITUAL_SERVICE_NOTICE_BODY,
  SPIRITUAL_SERVICE_NOTICE_TITLE,
} from '@/lib/spiritual-service-notice'

const NOTICE_LABELS: Record<string, string> = {
  TERMS: 'Terms of Service',
  PRIVACY: 'Privacy Notice',
  SPIRITUAL_NOTICE: SPIRITUAL_SERVICE_NOTICE_TITLE,
  MARKETING: 'Updates and announcements',
}

export const Route = createFileRoute('/admin/system/notices-consent')({
  component: AdminNoticesConsentPage,
})

function AdminNoticesConsentPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold">Notices & Consent</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Current consent versions and operator reminders for the customer notice
        flow.
      </p>

      <AdminHelpPanel title="How notices work">
        <p>
          Required notices must be accepted before a customer can complete the
          booking profile. Marketing consent is optional and never required for
          service access.
        </p>
        <p>
          Do not invent legal wording, sacred claims, outcomes, or user consent
          data. Update notice wording only through approved content and legal
          review.
        </p>
      </AdminHelpPanel>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-semibold tracking-wide text-ink">
          Required notices
        </h2>
        <dl className="mt-4 divide-y divide-line text-sm">
          {REQUIRED_CONSENT_TYPES.map((type) => (
            <div key={type} className="flex justify-between gap-4 py-3">
              <dt className="text-ink-soft">{NOTICE_LABELS[type] ?? type}</dt>
              <dd className="font-mono text-xs text-ink">
                v{CONSENT_VERSIONS[type]}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-semibold tracking-wide text-ink">
          {SPIRITUAL_SERVICE_NOTICE_TITLE}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          {SPIRITUAL_SERVICE_NOTICE_BODY}
        </p>
      </section>
    </div>
  )
}
