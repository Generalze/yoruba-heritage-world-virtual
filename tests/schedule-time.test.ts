import { describe, expect, it } from 'bun:test'

import {
  addDays,
  daysBetween,
  isValidTimeZone,
  isoDayOfWeek,
  localToUtcMs,
  minutesToTime,
  sqlToUtcMs,
  timeToMinutes,
  utcMsToLocal,
  utcMsToSql,
} from '@/lib/schedule-time'
import { mergeIntervals, subtractInterval } from '@/services/scheduling'

describe('timezone conversion (deterministic, machine-independent)', () => {
  it('converts Africa/Lagos local times to UTC (+01:00, no DST)', () => {
    const ms = localToUtcMs('Africa/Lagos', '2026-03-15', '09:00')
    expect(utcMsToSql(ms)).toBe('2026-03-15 08:00:00')
  })

  it('handles DST: the same London wall time maps to different UTC in winter vs summer', () => {
    const winter = localToUtcMs('Europe/London', '2026-01-15', '09:00')
    const summer = localToUtcMs('Europe/London', '2026-07-15', '09:00')
    expect(utcMsToSql(winter)).toBe('2026-01-15 09:00:00') // GMT
    expect(utcMsToSql(summer)).toBe('2026-07-15 08:00:00') // BST
  })

  it('round-trips UTC instants back to house-local wall time', () => {
    const ms = localToUtcMs('Africa/Lagos', '2026-05-01', '14:30')
    expect(utcMsToLocal('Africa/Lagos', ms)).toEqual({
      date: '2026-05-01',
      time: '14:30',
    })
    // The same instant reads differently in another zone — the UTC
    // instant itself never changes.
    expect(utcMsToLocal('America/New_York', ms).time).not.toBe('14:30')
  })

  it('round-trips SQL UTC strings', () => {
    const sql = '2026-08-09 13:45:00'
    expect(utcMsToSql(sqlToUtcMs(sql))).toBe(sql)
  })

  it('computes ISO weekdays and date arithmetic', () => {
    expect(isoDayOfWeek('2026-08-10')).toBe(1) // Monday
    expect(isoDayOfWeek('2026-08-16')).toBe(7) // Sunday
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02')
    expect(daysBetween('2026-08-01', '2026-08-31')).toBe(30)
  })

  it('validates IANA timezones', () => {
    expect(isValidTimeZone('Africa/Lagos')).toBe(true)
    expect(isValidTimeZone('GMT+1')).toBe(false)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
  })

  it('converts HH:MM to minutes and back', () => {
    expect(timeToMinutes('09:30')).toBe(570)
    expect(minutesToTime(570)).toBe('09:30')
    expect(timeToMinutes('17:00:00')).toBe(1020)
  })
})

describe('interval math', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(
      mergeIntervals([
        { start: 540, end: 720 },
        { start: 700, end: 800 },
        { start: 900, end: 960 },
      ]),
    ).toEqual([
      { start: 540, end: 800 },
      { start: 900, end: 960 },
    ])
  })

  it('subtracts a block from the middle, edges and outside', () => {
    const base = [{ start: 540, end: 1020 }] // 09:00–17:00
    expect(subtractInterval(base, { start: 720, end: 840 })).toEqual([
      { start: 540, end: 720 },
      { start: 840, end: 1020 },
    ])
    expect(subtractInterval(base, { start: 500, end: 600 })).toEqual([
      { start: 600, end: 1020 },
    ])
    expect(subtractInterval(base, { start: 1100, end: 1200 })).toEqual(base)
    expect(subtractInterval(base, { start: 0, end: 1440 })).toEqual([])
  })
})
