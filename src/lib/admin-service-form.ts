export interface AdminServiceFormRecord {
  id: number
}

export interface AdminServiceUpdateData {
  id: number
  name?: string
  slug?: string
  shortDescription?: string | null
  sacredHouseId?: number
  durationMinutes?: number | null
  priceMinor?: number | null
  currency?: string | null
  sortOrder?: number
}

const cleanOptionalNumber = (form: FormData, key: string): number | null => {
  const value = String(form.get(key) ?? '').trim()
  return value === '' ? null : Number(value)
}

/**
 * Disabled form controls are absent from FormData. Build a sparse patch so a
 * published service can update operational fields without submitting empty
 * content fields that the validator correctly rejects.
 */
export function buildAdminServiceUpdateData(
  service: AdminServiceFormRecord,
  form: FormData,
  options: { houseChangeable: boolean },
): AdminServiceUpdateData {
  const data: AdminServiceUpdateData = { id: service.id }

  if (form.has('name')) data.name = String(form.get('name') ?? '')
  if (form.has('slug')) data.slug = String(form.get('slug') ?? '')
  if (form.has('shortDescription')) {
    data.shortDescription = String(form.get('shortDescription') ?? '')
  }
  if (form.has('sortOrder'))
    data.sortOrder = cleanOptionalNumber(form, 'sortOrder') ?? 0
  if (options.houseChangeable && form.has('sacredHouseId')) {
    data.sacredHouseId = Number(form.get('sacredHouseId'))
  }
  if (form.has('durationMinutes')) {
    data.durationMinutes = cleanOptionalNumber(form, 'durationMinutes')
  }
  if (form.has('priceMinor'))
    data.priceMinor = cleanOptionalNumber(form, 'priceMinor')
  if (form.has('currency')) {
    const currency = String(form.get('currency') ?? '').trim()
    data.currency = currency === '' ? null : currency.toUpperCase()
  }

  return data
}
