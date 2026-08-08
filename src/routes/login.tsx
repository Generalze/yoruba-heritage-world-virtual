import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { getCurrentUserFn, loginFn } from '@/auth/actions'
import { authErrorMessage } from '@/auth/messages'
import { loginInputSchema } from '@/auth/validation'
import { FormError, SubmitButton, TextField } from '@/components/forms'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (user) throw redirect({ to: '/dashboard' })
  },
  component: LoginPage,
})

function LoginPage() {
  const login = useServerFn(loginFn)
  const router = useRouter()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = new FormData(event.currentTarget)
    const parsed = loginInputSchema.safeParse({
      email: form.get('email'),
      password: form.get('password'),
    })
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      )
      return
    }

    setBusy(true)
    try {
      const result = await login({ data: parsed.data })
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
        <h1 className="text-center text-3xl font-bold">Welcome back</h1>
        <p className="mt-2 text-center text-sm text-stone-400">
          Sign in to Yorùbá Heritage World Virtual
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4">
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
            autoComplete="current-password"
            required
            maxLength={128}
          />
          <FormError message={error} />
          <SubmitButton label="Sign in" busy={busy} />
        </form>

        <p className="mt-6 text-center text-sm text-stone-400">
          New here?{' '}
          <Link to="/register" className="text-amber-500 hover:text-amber-400">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  )
}
