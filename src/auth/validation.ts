import { z } from 'zod'

import { normalizeEmail } from './email'

/**
 * Zod validation for authentication inputs (stage spec §6, §11, §12).
 *
 * Password policy: length-based only. Minimum 10 characters so
 * passphrases work naturally; bounded maximum to prevent hashing-cost
 * abuse. No forced symbol/number/uppercase composition rules — length
 * contributes far more entropy than composition requirements, which
 * mostly punish legitimate users.
 */
export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 128

export const emailSchema = z
  .string('Email is required.')
  .transform(normalizeEmail)
  .pipe(z.email('Enter a valid email address.'))
  .pipe(z.string().max(255, 'Email is too long.'))

export const preferredNameSchema = z
  .string('Preferred name is required.')
  .trim()
  .min(1, 'Preferred name is required.')
  .max(100, 'Preferred name is too long.')

export const passwordSchema = z
  .string('Password is required.')
  .min(
    PASSWORD_MIN_LENGTH,
    `Use at least ${PASSWORD_MIN_LENGTH} characters — a longer passphrase works well.`,
  )
  .max(PASSWORD_MAX_LENGTH, 'Password is too long.')

export const registerInputSchema = z
  .object({
    email: emailSchema,
    preferredName: preferredNameSchema,
    password: passwordSchema,
    passwordConfirmation: z.string('Password confirmation is required.'),
  })
  .refine((data) => data.password === data.passwordConfirmation, {
    message: 'Passwords do not match.',
    path: ['passwordConfirmation'],
  })

export type RegisterInput = z.infer<typeof registerInputSchema>

export const loginInputSchema = z.object({
  email: emailSchema,
  password: z
    .string('Password is required.')
    .min(1, 'Password is required.')
    .max(PASSWORD_MAX_LENGTH, 'Password is too long.'),
})

export type LoginInput = z.infer<typeof loginInputSchema>
