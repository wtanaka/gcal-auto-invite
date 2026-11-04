// Auto-invite: adds a fixed list of extra email addresses (CONFIG.invitees) as
// attendees to your upcoming Google Calendar events.
//
// Requires the Google Calendar advanced service (see appsscript.json).
//
// CONFIG (me, invitees, optionally everyHours) comes from Config.gs, which the
// CLI generates from accounts/<name>/config.json; see the README. Run
// installTrigger() once from the editor to grant access and schedule
// addOtherEmailInvites().

var DEFAULTS = {
  // How often installTrigger() schedules a run: 1, 2, 4, 6, 8 or 12 hours.
  everyHours: 4,
};

function getConfig() {
  return Object.assign({}, DEFAULTS, CONFIG);
}

function getMyResponse(event) {
  if (event && event.attendees && event.attendees.length > 0) {
    var theMeAttendees = event.attendees.filter(
      (attendee) => attendee.email === getConfig().me,
    );
    if (theMeAttendees.length) {
      return theMeAttendees[0].responseStatus;
    }
  }
  return "NOT APPLICABLE";
}

function getMaxStart(events) {
  var maxStart = events
    .map((event) => event["xParsedStart"])
    // All-day events have no dateTime and parse to NaN.
    .filter((startTimestamp) => !isNaN(startTimestamp))
    .reduce((a, b) => Math.max(a, b), -1);
  return maxStart;
}

function getEvents(calendarId, now) {
  const MAX_RESULTS = 250;
  var result = Calendar.Events.list(calendarId, {
    singleEvents: true,
    timeMin: now.toISOString(),
    orderBy: "startTime",
    maxResults: MAX_RESULTS,
  });
  console.log(
    "Query for events starting at " +
      now +
      " returned " +
      result["items"].length +
      " items",
  );

  var events = Object.entries(result["items"])
    // items are arrays that look like [arrayIdx, item] so we get the item
    .map((entry) => entry[1])
    // Enhance with parsed start date, end date, and invite response
    .map((event) =>
      Object.assign(
        {
          xParsedStart: Date.parse(event["start"]["dateTime"]),
          xParsedEnd: Date.parse(event["end"]["dateTime"]),
          xMyResponse: getMyResponse(event),
        },
        event,
      ),
    );

  if (result["items"].length == MAX_RESULTS) {
    // Ignore events after the max start date, because we may not have all
    // events with that same start date.
    var maxStart = getMaxStart(events);
    console.log("maxStart is ", maxStart);
    events = events.filter((event) => event["xParsedStart"] != maxStart);
    console.log(
      "After truncating events on " +
        new Date(maxStart) +
        ", there are " +
        events.length +
        " left",
    );
  } else {
    console.log(
      "No need to truncate because original query returned less than " +
        MAX_RESULTS +
        " results",
    );
  }

  return events;
}

function filterToEventsMissingInvitee(inviteeEmails, events) {
  return events.filter((event) => {
    // Only regular events; skip birthdays, fromGmail, focus time, etc.
    if (event.eventType && event.eventType !== "default") {
      return false;
    } else if (!event.attendees) {
      console.log("this event has no attendees", event);
      return true;
    } else if (event.attendees.length == 0) {
      console.log("this event has empty attendee list", event);
      return false;
    } else {
      const existingEmails = event.attendees.map((att) => att.email);
      // Returns true if at least one required email is not in the attendee list
      return inviteeEmails.some((email) => !existingEmails.includes(email));
    }
  });
}

function addInvitee(calendarId, inviteeEmails, events) {
  events.forEach((event) => {
    var existingAttendees = event.attendees || [];
    var existingEmails = existingAttendees.map((a) => a.email);

    // Identify which emails from our list are not yet present
    var missingEmails = inviteeEmails.filter(
      (email) => !existingEmails.includes(email),
    );

    if (missingEmails.length > 0) {
      console.log(
        "adding " + missingEmails.join(", ") + " to " + event.summary,
      );

      // Map missing strings to attendee objects and combine with existing list
      var newAttendees = existingAttendees.concat(
        missingEmails.map((email) => ({ email: email })),
      );

      Calendar.Events.patch(
        {
          attendees: newAttendees,
        },
        calendarId,
        event.id,
      );
    }
  });
}

function addOtherEmailInvites() {
  var calendarId = "primary";
  var queryMinDate = new Date();
  var sourceEvents = getEvents(calendarId, queryMinDate);

  var eventsMissingInvitee = filterToEventsMissingInvitee(
    getConfig().invitees,
    sourceEvents,
  );
  addInvitee(calendarId, getConfig().invitees, eventsMissingInvitee);
}

// Run once from the editor: replaces any existing trigger for
// addOtherEmailInvites() with one that runs every getConfig().everyHours hours.
// Safe to run again after changing the interval.
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(
      (trigger) => trigger.getHandlerFunction() === "addOtherEmailInvites",
    )
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger("addOtherEmailInvites")
    .timeBased()
    .everyHours(getConfig().everyHours)
    .create();
  console.log(
    "Installed trigger: every " + getConfig().everyHours + " hour(s)",
  );
}
