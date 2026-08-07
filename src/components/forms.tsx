/** Minimal shared form primitives for the foundation auth pages. */

export function TextField(props: {
  label: string
  name: string
  type: string
  autoComplete?: string
  required?: boolean
  minLength?: number
  maxLength?: number
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-300">
        {props.label}
      </span>
      <input
        name={props.name}
        type={props.type}
        autoComplete={props.autoComplete}
        required={props.required}
        minLength={props.minLength}
        maxLength={props.maxLength}
        className="w-full rounded-md border border-stone-700 bg-stone-900 px-3 py-2 text-stone-100 placeholder-stone-500 focus:border-amber-500 focus:outline-none"
      />
    </label>
  )
}

export function FormError(props: { message: string | null }) {
  if (!props.message) return null
  return (
    <p
      role="alert"
      className="rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300"
    >
      {props.message}
    </p>
  )
}

export function SubmitButton(props: { label: string; busy: boolean }) {
  return (
    <button
      type="submit"
      disabled={props.busy}
      className="w-full rounded-md bg-amber-600 px-4 py-2 font-semibold text-stone-950 transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {props.busy ? 'Please wait…' : props.label}
    </button>
  )
}
