# jobs/

Background job processing built on a database-backed queue
(TECHNICAL_CANON.md §3.1 and §21) — video generation, notifications,
reminders, subscription scheduling.

Empty at the foundation stage. No Redis: the relational database itself
is the job queue until load proves otherwise. The Docker/VPS layout keeps
room for a separate worker process that will consume this module.
