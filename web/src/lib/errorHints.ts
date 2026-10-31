// Plain-language next steps for Klipper errors that come up while setting up
// and running a toolchanger.
const HINTS: [RegExp, string][] = [
  [
    /No trigger on probe after full movement/i,
    "The probe went all the way down without touching anything. During a gantry level (QGL) that usually means the gantry is far out of level: turn the motors off, push the gantry down evenly by hand (or level it by eye), then Home all and level again. At the bed centre, check the tool's probe: Detect tool should show it on the gantry, and pressing the nozzle up should change that.",
  ],
  [
    /Probe triggered prior to movement/i,
    'The probe already read triggered before it moved: the nozzle may be resting on something, or the tool is not seated on the gantry.',
  ],
  [
    /max_adjust/i,
    "The gantry is further out of level than QGL may correct in one go: turn the motors off, level the gantry by hand, Home all, then level again.",
  ],
  [/Must home (axis first|before probe)/i, 'Home the printer first (Home all).'],
  [/Move out of range/i, 'A move went past an axis limit (stepper position_min/position_max).'],
]

/** A hint for a Klipper error message, or '' when there is none. */
export function errorHint(message: string): string {
  return HINTS.find(([re]) => re.test(message))?.[1] ?? ''
}
