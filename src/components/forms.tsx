import { ErrorNotice, Field, buttonClass, inputClass } from './ui'

/**
 * Auth-page form primitives. These delegate to the shared UI kit so
 * the sign-in and registration forms cannot drift from the rest of the
 * platform's field styling, focus treatment or error presentation.
 */

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
    <Field label={props.label}>
      <input
        name={props.name}
        type={props.type}
        autoComplete={props.autoComplete}
        required={props.required}
        minLength={props.minLength}
        maxLength={props.maxLength}
        className={inputClass}
      />
    </Field>
  )
}

export function FormError(props: { message: string | null }) {
  return <ErrorNotice message={props.message} />
}

export function SubmitButton(props: { label: string; busy: boolean }) {
  return (
    <button
      type="submit"
      disabled={props.busy}
      className={`${buttonClass('primary', 'md')} w-full disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {props.busy ? 'Please wait…' : props.label}
    </button>
  )
}
