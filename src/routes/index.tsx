import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
      <div className="w-full max-w-2xl text-center">
        <p className="mb-4 text-sm font-medium tracking-[0.3em] text-amber-500 uppercase">
          Yorùbá Heritage Sacred House
        </p>
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Yorùbá Heritage World Virtual
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-stone-300">
          A digital home for Yorùbá prayer, ancestral connection and sacred
          cultural practice.
        </p>

        <div className="mt-10 inline-flex items-center gap-2 rounded-full border border-stone-700 bg-stone-900 px-4 py-2 text-sm text-stone-300">
          <span
            className="h-2 w-2 rounded-full bg-emerald-500"
            aria-hidden="true"
          />
          Application foundation running — Phase One, Step 1
        </div>

        <p className="mt-10 text-sm text-stone-500">
          Sacred Houses, appointments, Prayer Rooms and subscriptions arrive in
          later approved stages.
        </p>
      </div>
    </main>
  )
}
