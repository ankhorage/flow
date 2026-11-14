/** Determine whether one UTC instant matches a five-field POSIX cron expression in an IANA zone. */
export const isCronDueAt = (input: {
  readonly cron: string;
  readonly now: Date;
  readonly timezone?: string;
}): boolean => {
  const fields = input.cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('FLOW_CRON_INVALID');
  const local = localParts(input.now, input.timezone ?? 'Etc/UTC');
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  )
    throw new Error('FLOW_CRON_INVALID');
  const minuteMatches = matchesField(minute, local.minute, 0, 59);
  const hourMatches = matchesField(hour, local.hour, 0, 23);
  const monthMatches = matchesField(month, local.month, 1, 12);
  const dayOfMonthMatches = matchesField(dayOfMonth, local.day, 1, 31);
  const dayOfWeekMatches = matchesField(dayOfWeek, local.dayOfWeek, 0, 7);
  const dayMatches =
    dayOfMonth === '*' || dayOfWeek === '*'
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return minuteMatches && hourMatches && monthMatches && dayMatches;
};

/** Format a UTC instant into its real local wall-clock fields; duplicate fall-back instants remain distinct instants. */
const localParts = (
  now: Date,
  timezone: string,
): {
  readonly day: number;
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
} => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      minute: 'numeric',
      month: 'numeric',
      timeZone: timezone,
      weekday: 'short',
    }).formatToParts(now);
    const read = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? invalidTimezone();
    return {
      day: Number(read('day')),
      dayOfWeek: weekday(read('weekday')),
      hour: Number(read('hour')),
      minute: Number(read('minute')),
      month: Number(read('month')),
    };
  } catch {
    throw new Error('FLOW_CRON_TIMEZONE_INVALID');
  }
};

/** Match one POSIX cron field including lists, ranges, and positive step values. */
const matchesField = (field: string, value: number, minimum: number, maximum: number): boolean =>
  field.split(',').some((part) => matchesPart(part, value, minimum, maximum));

/** Match one validated cron list member. */
const matchesPart = (part: string, value: number, minimum: number, maximum: number): boolean => {
  const [rangePart, stepPart] = part.split('/');
  if (part.split('/').length > 2 || rangePart === undefined) throw new Error('FLOW_CRON_INVALID');
  const step = stepPart === undefined ? 1 : parseValue(stepPart, 1, maximum - minimum + 1);
  const [start, end] = parseRange(rangePart, minimum, maximum);
  return value >= start && value <= end && (value - start) % step === 0;
};

/** Parse a wildcard, number, or inclusive numeric range. */
const parseRange = (range: string, minimum: number, maximum: number): readonly [number, number] => {
  if (range === '*') return [minimum, maximum];
  const values = range.split('-');
  if (values.length === 1) {
    const [single] = values;
    if (single === undefined) throw new Error('FLOW_CRON_INVALID');
    const value = parseValue(single, minimum, maximum);
    return [value, value];
  }
  if (values.length !== 2 || values[0] === undefined || values[1] === undefined)
    throw new Error('FLOW_CRON_INVALID');
  const start = parseValue(values[0], minimum, maximum);
  const end = parseValue(values[1], minimum, maximum);
  if (end < start) throw new Error('FLOW_CRON_INVALID');
  return [start, end];
};

/** Parse one strict POSIX cron integer. */
const parseValue = (value: string, minimum: number, maximum: number): number => {
  if (!/^\d+$/.test(value)) throw new Error('FLOW_CRON_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error('FLOW_CRON_INVALID');
  return parsed;
};

/** Map English short weekday names produced by the fixed formatter to POSIX weekday values. */
const weekday = (value: string): number => {
  switch (value) {
    case 'Sun':
      return 0;
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      return invalidTimezone();
  }
};

/** Keep an impossible formatter shape distinct from a cron syntax error. */
const invalidTimezone = (): never => {
  throw new Error('FLOW_CRON_TIMEZONE_INVALID');
};
