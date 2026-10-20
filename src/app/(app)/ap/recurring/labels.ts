/** Words for a recurring bill's type; frequencies are shared with recurring invoices. */
export { FREQUENCY_LABEL } from "../../ar/recurring/labels";

export const BILL_TYPE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  reminder: "Reminder",
  unscheduled: "Unscheduled",
};

export const BILL_TYPE_NOTE: Record<string, string> = {
  scheduled: "Each bill is created on its date and submitted for approval.",
  reminder: "Each bill is created as a draft and waits in the review queue.",
  unscheduled: "Nothing runs on its own. Use the template to make a bill.",
};
