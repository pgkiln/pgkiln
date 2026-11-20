-- Sprint 240 (MG-7): a submit from a modal dialog page that stays in the dialog.
--
-- Until now every submit of a modal page (with a button) closed the dialog: the page below was refreshed and its
-- dialog_closed actions ran. A button with stay_in_dialog shows the dialog page again after its processes, with
-- their success message, so a dialog can be a multi-step flow (upload, preview, import). A close_dialog process
-- still closes it. A branch with stay_in_dialog goes to its target inside the dialog (dialog=1) instead of
-- closing it; without it, a branch in a dialog is ignored as before. Outside a dialog both do nothing.
--
-- Both columns are nullable (null: false), so older exports import unchanged.

alter table meta.button add column stay_in_dialog boolean;
alter table meta.branch add column stay_in_dialog boolean;

comment on column meta.button.stay_in_dialog is 'A submit from a modal dialog page shows the dialog page again instead of closing it (sprint 240)';
comment on column meta.branch.stay_in_dialog is 'In a modal dialog page, the branch goes to its target inside the dialog instead of closing it (sprint 240)';
