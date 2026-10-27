/**
 * The name a save is given when nobody types one.
 *
 * It used to be the tick number, and a tick is not a label: two different worlds
 * reach tick 200, and the same world is at tick 200 exactly once — so the name
 * identified the moment in the simulation rather than the save, and a list of
 * them read as a sequence that had never happened. A local timestamp says when
 * the save was made, which is the thing a person is choosing between.
 *
 * Local time rather than UTC, deliberately: the list is read by whoever pressed
 * Save, and the unambiguous instant is already inside the entry as `savedAt`
 * (ISO 8601, UTC). The format is fixed width and most-significant first, so it
 * also sorts as text — which is what the panel does when two entries are saved
 * in the same millisecond and only `savedAt` could break the tie.
 */
export function defaultWorldName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * The same name, made distinct from any already taken.
 *
 * A timestamp has one-second resolution, so two saves inside the same second
 * would collide — and the collision would arrive as the overwrite prompt, asking
 * whether to replace a world that is a different world. Saving twice quickly is
 * an ordinary thing to do (save, step, save), so the suffix goes on the second
 * one instead of the prompt.
 */
export function uniqueWorldName(base: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base} (${n})`;
    if (!isTaken(candidate)) return candidate;
  }
  // Ninety-nine saves in one second means something other than a person is
  // calling this; the caller's overwrite prompt is still the honest answer.
  return base;
}
