import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { getCurrentUserFn, registerFn } from '@/auth/actions'
import { authErrorMessage } from '@/auth/messages'
import { registerInputSchema } from '@/auth/validation'
import { FormError, SubmitButton, TextField } from '@/components/forms'

export const Route = createFileRoute('/register')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (user) throw redirect({ to: '/dashboard' })
  },
  component: RegisterPage,
})

function RegisterPage() {
  const register = useServerFn(registerFn)
  const router = useRouter()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = new FormData(event.currentTarget)
    const parsed = registerInputSchema.safeParse({
      email: form.get('email'),
      preferredName: form.get('preferredName'),
      password: form.get('password'),
      passwordConfirmation: form.get('passwordConfirmation'),
    })
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      )
      return
    }

    setBusy(true)
    try {
      const result = await register({ data: parsed.data })
      if (result.ok) {
        await router.invalidate()
        await navigate({ to: '/dashboard' })
      } else {
        setError(authErrorMessage(result.error))
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-950 px-6 py-12 text-stone-100">
      <div className="w-full max-w-md">
        <h1 className="text-center text-3xl font-bold">Create your account</h1>
        <p className="mt-2 text-center text-sm text-stone-400">
          Join Yorùbá Heritage World Virtual
        </p>

        <form
          onSubmit={handleSubmit}
          className="mt-8 space-y-4"
          noValidate={false}
        >
          <TextField
            label="Preferred name"
            name="preferredName"
            type="text"
            autoComplete="name"
            required
            maxLength={100}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={255}
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
          />
          <p className="text-xs text-stone-500">
            At least 10 characters — a longer passphrase works well.
          </p>
          <TextField
            label="Confirm password"
            name="passwordConfirmation"
            type="password"
            autoComplete="new-password"
            required
            maxLength={128}
          />
          <FormError message={error} />
          <SubmitButton label="Create account" busy={busy} />
        </form>

        <p className="mt-6 text-center text-sm text-stone-400">
          Already have an account?{' '}
          <Link to="/login" className="text-amber-500 hover:text-amber-400">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  )
}
