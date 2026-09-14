import { createFileRoute, Link } from '@tanstack/react-router'

import { AdminHelpPanel } from '@/components/admin'

const GUIDE_SECTIONS: Array<{
  label: string
  to: string
  body: string
}> = [
  {
    label: 'Overview',
    to: '/admin',
    body: 'Operational dashboard for review depth, generation health and upcoming confirmed appointments.',
  },
  {
    label: 'Deity Profiles',
    to: '/admin/catalogue/deities',
    body: 'Catalogue identities and relationships for approved deity profile records. Do not invent sacred claims.',
  },
  {
    label: 'Sacred Houses',
    to: '/admin/catalogue/sacred-houses',
    body: 'Sacred House records, focus areas and members. Customers book the House, never an individual.',
  },
  {
    label: 'Services',
    to: '/admin/catalogue/services',
    body: 'Bookable service records. Use USD prices only and do not show a customer-facing fixed duration.',
  },
  {
    label: 'Review Queue',
    to: '/admin/catalogue/review',
    body: 'Approval queue for catalogue records submitted by authors before publication.',
  },
  {
    label: 'Scheduling',
    to: '/admin/scheduling',
    body: 'House-level booking switch, availability windows and date exceptions. Members do not have public calendars.',
  },
  {
    label: 'Appointments',
    to: '/admin/appointments',
    body: 'Confirmed and pending bookings. Upload prepared Prayer Room videos only after verified payment confirms the appointment.',
  },
  {
    label: 'Payments',
    to: '/admin/payments',
    body: 'Payment evidence and review queue. PayPal is live, Stripe is disabled, and payment states come only from verified providers.',
  },
  {
    label: 'Spiritual Guidance',
    to: '/admin/spiritual-content',
    body: 'Approved guidance content library. Draft, review and publish through the workflow; do not invent sacred content.',
  },
  {
    label: 'Sacred Content',
    to: '/admin/sacred-content',
    body: 'Runtime sacred content with rights and publication gates before use in prepared experiences.',
  },
  {
    label: 'Prayer Templates',
    to: '/admin/prayer-templates',
    body: 'Structured templates for approved prayer-session composition. Templates reference approved content rather than free text.',
  },
  {
    label: 'Media',
    to: '/admin/media-assets',
    body: 'Governed audio, image and video assets. Media remains private unless explicitly published through approved flows.',
  },
  {
    label: 'Visual Bibles',
    to: '/admin/visual-bibles',
    body: 'Visual reference packs and rules for Sacred House imagery and production consistency.',
  },
  {
    label: 'Recipes',
    to: '/admin/video-recipes',
    body: 'Technical recipe previews and metadata for video assembly; no private notes, storage keys or sacred text.',
  },
  {
    label: 'Generation',
    to: '/admin/generation-jobs',
    body: 'Legacy generation queue inspection. Automated visual generation and TTS are currently disabled; manual upload is the Phase-One path.',
  },
]

export const Route = createFileRoute('/admin/system/guide')({
  component: AdminGuidePage,
})

function AdminGuidePage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Admin Guide</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        A short operating guide for the current admin menu.
      </p>

      <AdminHelpPanel title="Core flow">
        <p>
          Booking - Verified Payment - Confirmed Appointment - Video Upload -
          Prayer Room locked until scheduled time - Available - Completed.
        </p>
        <p>
          Global currency is USD. PayPal is live, Stripe is disabled, Prayer
          Room upload maximum is 1 GiB, and Prayer Room media is private.
        </p>
      </AdminHelpPanel>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {GUIDE_SECTIONS.map((item) => (
          <section
            key={item.label}
            className="rounded-lg border border-line bg-surface-raised p-5"
          >
            <h2 className="text-sm font-semibold tracking-wide text-ink">
              <Link to={item.to} className="hover:text-gold-deep">
                {item.label}
              </Link>
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {item.body}
            </p>
          </section>
        ))}
      </div>
    </div>
  )
}
