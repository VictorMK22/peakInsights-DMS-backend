/**
 * Virtual-meeting rules shared by the meeting create/update flow.
 *
 * A meeting whose location says it is virtual ("Virtual", "Online", "Zoom",
 * "Google Meet", ...) must carry a join link, otherwise invitees get an
 * invitation with nothing to click. The organizer either generates a Zoho
 * Meeting link or types / pastes one created elsewhere.
 */
const VIRTUAL_LOCATION_PATTERN =
  /\b(virtual|virtually|online|remote|zoom|ms teams|microsoft teams|google meet|gmeet|zoho meeting|webex|skype|video\s*(call|conference)|web\s*conference)\b/i;

export const isVirtualLocation = (location?: string | null): boolean =>
  !!location && VIRTUAL_LOCATION_PATTERN.test(location);

export const VIRTUAL_MEETING_LINK_REQUIRED_MESSAGE =
  "A virtual meeting needs a meeting link. Generate a Zoho Meeting link, or paste the link if you created it elsewhere.";