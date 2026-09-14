import { describe, expect, it } from 'bun:test'

import { buildAdminServiceUpdateData } from '@/lib/admin-service-form'

describe('admin service edit form payload', () => {
  it('omits disabled published content fields during a price-only edit', () => {
    const form = new FormData()
    form.set('durationMinutes', '60')
    form.set('priceMinor', '500')
    form.set('currency', 'usd')

    const data = buildAdminServiceUpdateData({ id: 10 }, form, {
      houseChangeable: false,
    })

    expect(data).toEqual({
      id: 10,
      durationMinutes: 60,
      priceMinor: 500,
      currency: 'USD',
    })
    expect('name' in data).toBe(false)
    expect('slug' in data).toBe(false)
    expect('sortOrder' in data).toBe(false)
  })
})
