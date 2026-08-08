import { Link, createFileRoute } from '@tanstack/react-router'

/**
 * Olódùmárè is deliberately NOT a record in the deities collection and
 * this page performs no catalogue queries. Only approved project
 * wording appears here (canon §1: "Olódùmárè is presented separately
 * and respectfully, not as one equivalent deity among others"). No
 * further theological content may be added without authorised
 * cultural/spiritual approval.
 */
export const Route = createFileRoute('/olodumare')({
  component: OlodumarePage,
})

function OlodumarePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 py-12 text-stone-100">
      <div className="w-full max-w-2xl text-center">
        <p className="text-sm font-medium tracking-[0.3em] text-amber-500 uppercase">
          Yorùbá Heritage World Virtual
        </p>
        <h1 className="mt-4 text-4xl font-bold">Olódùmárè</h1>
        <p className="mt-8 text-lg leading-relaxed text-stone-300">
          Olódùmárè is presented separately and respectfully within the
          spiritual structure of the platform.
        </p>
        <p className="mt-4 text-lg leading-relaxed text-stone-300">
          Olódùmárè is not presented as one deity among a collection of
          equivalent spiritual profiles.
        </p>
        <div className="mt-10">
          <Link to="/" className="text-sm text-stone-400 hover:text-amber-500">
            ← Return home
          </Link>
        </div>
      </div>
    </main>
  )
}
