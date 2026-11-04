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

// Why you cannot change the guest list of this event, or "" if you can try: you
// organize it, it lets guests modify it, or it lets guests invite others (the
// default). A guest who cannot see every guest only has a partial list, and
// patching with it could drop the other guests.
function whyCannotChangeGuests(event) {
  if (event.attendeesOmitted) {
    return "Google omitted part of the guest list";
  }
  var isOrganizer = !event.organizer || event.organizer.self;
  if (
    !isOrganizer &&
    !event.guestsCanModify &&
    event.guestsCanInviteOthers === false
  ) {
    return "the organizer does not let guests invite others";
  }
  return "";
}

function filterToEventsMissingInvitee(inviteeEmails, events) {
  return events.filter((event) => {
    // Only regular events; skip birthdays, fromGmail, focus time, etc.
    if (event.eventType && event.eventType !== "default") {
      return false;
    } else if (whyCannotChangeGuests(event)) {
      console.log(
        "skipping " + event.summary + ": " + whyCannotChangeGuests(event),
      );
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

// Patches the missing invitees onto one event and checks that Google applied
// them (it can accept a patch without applying it).
function patchInvitees(calendarId, event, missingEmails, sendUpdates) {
  console.log(
    "adding " +
      missingEmails.join(", ") +
      " to " +
      event.summary +
      " (id " +
      event.id +
      ", type " +
      event.eventType +
      ", organizer " +
      (event.organizer && event.organizer.email) +
      ", guestsCanInviteOthers " +
      event.guestsCanInviteOthers +
      ", guestsCanModify " +
      event.guestsCanModify +
      ", guestsCanSeeOtherGuests " +
      event.guestsCanSeeOtherGuests +
      ")",
  );
  var newAttendees = (event.attendees || []).concat(
    missingEmails.map((email) => ({ email: email })),
  );
  var updated = Calendar.Events.patch(
    { attendees: newAttendees },
    calendarId,
    event.id,
    { sendUpdates: sendUpdates },
  );
  var stillMissing = getMissingInvitees(missingEmails, updated || {});
  if (stillMissing.length > 0) {
    throw new Error(
      "Google accepted the change but the event still lacks " +
        stillMissing.join(", ") +
        "; attendees now: " +
        ((updated && updated.attendees) || []).map((a) => a.email).join(", "),
    );
  }
}

// Adds the missing invitees to each event. For an instance of a recurring
// event the series itself is updated (once), so every instance, including
// future ones, gets the invitees; an instance is only patched on its own when
// the series already has them. One event failing (for example one you are not
// allowed to modify) does not stop the rest. Returns the failures.
function addInvitee(calendarId, inviteeEmails, events, sendUpdates) {
  var failures = [];
  var masters = {}; // series id -> recurring event, once fetched
  var done = {}; // series ids already updated or already failed
  events.forEach((event) => {
    var seriesId = event.recurringEventId;
    try {
      if (seriesId && done[seriesId]) {
        return;
      }
      var target = event;
      if (seriesId) {
        masters[seriesId] =
          masters[seriesId] || Calendar.Events.get(calendarId, seriesId);
        if (getMissingInvitees(inviteeEmails, masters[seriesId]).length > 0) {
          target = masters[seriesId];
        }
      }
      var missingEmails = getMissingInvitees(inviteeEmails, target);
      if (missingEmails.length == 0) {
        return;
      }
      patchInvitees(calendarId, target, missingEmails, sendUpdates);
      if (target !== event) {
        done[seriesId] = true;
      }
    } catch (e) {
      console.error("could not update " + event.summary + ": " + e);
      failures.push({ id: event.id, summary: event.summary, error: String(e) });
      if (seriesId) {
        done[seriesId] = true; // do not retry the series for every instance
      }
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
