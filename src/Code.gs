// Auto-invite: adds a fixed list of extra email addresses (CONFIG.invitees) as
// attendees to your upcoming Google Calendar events.
//
// Requires the Google Calendar advanced service (see appsscript.json).
//
// CONFIG (invitees, plus any overrides of DEFAULTS) comes from Config.gs, which
// the CLI generates from accounts/<name>/config.json; see the README. Run
// installTrigger() once from the editor to grant access and schedule
// addOtherEmailInvites().

var DEFAULTS = {
  // How often installTrigger() schedules a run: 1, 2, 4, 6, 8 or 12 hours.
  everyHours: 4,
  // How far ahead to look for events that need the invitees added.
  lookaheadDays: 90,
  // Whether Google emails the invitees about the change: "none", "all" or
  // "externalOnly".
  sendUpdates: "none",
};

function getConfig() {
  return Object.assign({}, DEFAULTS, CONFIG);
}

function normalizeEmail(email) {
  return String(email || "").toLowerCase();
}

// Lists every event between timeMin and timeMax, following result pages.
function listEvents(calendarId, timeMin, timeMax) {
  var events = [];
  var pageToken;
  do {
    var args = {
      singleEvents: true,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      orderBy: "startTime",
      maxResults: 250,
    };
    if (pageToken) {
      args.pageToken = pageToken;
    }
    var result = Calendar.Events.list(calendarId, args);
    events = events.concat(result.items || []);
    pageToken = result.nextPageToken;
  } while (pageToken);
  console.log("Found " + events.length + " events from " + timeMin);
  return events;
}

// The invitees that are not yet attendees of the event (case-insensitive).
function getMissingInvitees(inviteeEmails, event) {
  var existing = (event.attendees || []).map((a) => normalizeEmail(a.email));
  return inviteeEmails.filter(
    (email) => !existing.includes(normalizeEmail(email)),
  );
}

function filterToEventsMissingInvitee(inviteeEmails, events) {
  return events.filter((event) => {
    // Only regular events; skip birthdays, fromGmail, focus time, etc.
    if (event.eventType && event.eventType !== "default") {
      return false;
    } else if (!event.attendees) {
      return true;
    } else if (event.attendees.length == 0) {
      return false;
    } else {
      return getMissingInvitees(inviteeEmails, event).length > 0;
    }
  });
}

// Adds the missing invitees to each event. One event failing (for example one
// you are not allowed to modify) does not stop the rest. Returns the failures.
function addInvitee(calendarId, inviteeEmails, events, sendUpdates) {
  var failures = [];
  events.forEach((event) => {
    var missingEmails = getMissingInvitees(inviteeEmails, event);
    if (missingEmails.length == 0) {
      return;
    }
    console.log("adding " + missingEmails.join(", ") + " to " + event.summary);
    var newAttendees = (event.attendees || []).concat(
      missingEmails.map((email) => ({ email: email })),
    );
    try {
      Calendar.Events.patch({ attendees: newAttendees }, calendarId, event.id, {
        sendUpdates: sendUpdates,
      });
    } catch (e) {
      console.error("could not update " + event.summary + ": " + e);
      failures.push({ id: event.id, summary: event.summary, error: String(e) });
    }
  });
  return failures;
}

function addOtherEmailInvites() {
  // Skip this run if the previous one is still going.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log("Another run is in progress; skipping");
    return;
  }
  try {
    var config = getConfig();
    var calendarId = "primary";
    var now = new Date();
    var until = new Date(now.getTime() + config.lookaheadDays * 86400000);
    var events = listEvents(calendarId, now, until);
    var failures = addInvitee(
      calendarId,
      config.invitees,
      filterToEventsMissingInvitee(config.invitees, events),
      config.sendUpdates,
    );
    if (failures.length > 0) {
      // Fail the run so Apps Script reports it, after trying every event.
      throw new Error(
        failures.length +
          " event(s) could not be updated: " +
          failures.map((f) => f.summary + " (" + f.error + ")").join("; "),
      );
    }
  } finally {
    lock.releaseLock();
  }
}

// Run once from the editor: replaces any existing trigger for
// addOtherEmailInvites() with one that runs every `everyHours` hours.
// Safe to run again after changing the interval.
function installTrigger() {
  var hours = getConfig().everyHours;
  ScriptApp.getProjectTriggers()
    .filter(
      (trigger) => trigger.getHandlerFunction() === "addOtherEmailInvites",
    )
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger("addOtherEmailInvites")
    .timeBased()
    .everyHours(hours)
    .create();
  console.log("Installed trigger: every " + hours + " hour(s)");
}
