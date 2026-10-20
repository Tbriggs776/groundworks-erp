/** Words for a recurring template's schedule, shared by its pages. */

export const FREQUENCY_LABEL: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannually: "Every 6 months",
  annually: "Yearly",
};

export const TYPE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  reminder: "Reminder",
  unscheduled: "Unscheduled",
};

export const TYPE_NOTE: Record<string, string> = {
  scheduled: "Each invoice is created and posted on its date.",
  reminder: "Each invoice is created as a draft and waits in the review queue.",
  unscheduled: "Nothing runs on its own. Use the template to make an invoice.",
};
