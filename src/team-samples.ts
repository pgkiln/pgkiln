// (sprint 113, WS-3) Team Development's set-up wizard (APEX: Team Development → Set up): sample label groups
// and labels, issue templates, canned responses and milestones, per builder language. Only English is written
// so far: add a language by adding an entry to TEAM_SAMPLES with the same structure (the wizard offers every
// key). Names stay short: labels and milestones are at most 40 characters, templates 60.

export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'gray';

export interface TeamSample {
  /** the language's name in its own language (the wizard's choice) */
  language: string;
  groups: { name: string; description: string; labels: { name: string; color: LabelColor; description: string }[] }[];
  milestones: { name: string; description: string; /** due in this many days from the set-up */ dueInDays: number | null }[];
  issueTemplates: { name: string; title: string; body: string; labels: string[] }[];
  responses: { name: string; body: string }[];
}

export const TEAM_SAMPLES: Record<string, TeamSample> = {
  en: {
    language: 'English',
    groups: [
      {
        name: 'Type',
        description: 'What kind of work the issue is.',
        labels: [
          { name: 'Bug', color: 'red', description: 'Something does not work as it should.' },
          { name: 'Feature', color: 'blue', description: 'New functionality.' },
          { name: 'Task', color: 'teal', description: 'Work to do that is neither a bug nor a feature.' },
        ],
      },
      {
        name: 'Priority',
        description: 'How soon it should be done.',
        labels: [
          { name: 'High', color: 'orange', description: 'Do this first.' },
          { name: 'Medium', color: 'yellow', description: 'Do this soon.' },
          { name: 'Low', color: 'gray', description: 'Do this when there is time.' },
        ],
      },
    ],
    milestones: [
      { name: '1.0', description: 'The first release.', dueInDays: 30 },
      { name: '1.1', description: 'The first update after the release.', dueInDays: 90 },
      { name: 'Backlog', description: 'Not planned yet.', dueInDays: null },
    ],
    issueTemplates: [
      {
        name: 'Bug report',
        title: 'Bug: ',
        labels: ['Bug'],
        body: '## What happens\n\n\n## What should happen\n\n\n## Steps to reproduce\n\n1. \n2. \n3. \n\n## Environment\n\nApplication, page, browser, user:\n',
      },
      {
        name: 'Feature request',
        title: 'Feature: ',
        labels: ['Feature'],
        body: '## The problem\n\nWho needs this, and why?\n\n## The proposal\n\n\n## Done when\n\n- \n',
      },
      {
        name: 'Task',
        title: '',
        labels: ['Task'],
        body: '## To do\n\n- [ ] \n- [ ] \n',
      },
    ],
    responses: [
      { name: 'Thanks, we will look at it', body: 'Thank you for reporting this. We will look at it and keep this issue up to date.' },
      { name: 'Need more information', body: 'Could you tell us more? Which page were you on, what did you do, and what did you expect to happen?' },
      { name: 'Fixed', body: 'This is fixed and will be in the next release.' },
      { name: 'Duplicate', body: 'This is the same as another issue; we follow it up there.' },
    ],
  },
};

export const TEAM_LANGUAGES = Object.keys(TEAM_SAMPLES);
