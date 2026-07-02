# vik task tracking

this repo uses vikunja for task tracking via the `vik` CLI.

Useful commands:

```sh
# list unfinished tasks you've claimed (to restore context in case you got interrupted).
# --done takes todo/doing/done; use a raw filter for "anything not done" (todo + doing).
vik list --mine --filter 'done = false' --compact

# list just what you've got in progress
vik list --mine --done doing --compact

# list tasks in blocker order
vik list --topo-sort --filter 'done = false' --compact

# claim a task, then mark it in progress (--compact trims the returned task)
vik modify $TASK_ID --mine --compact
vik modify $TASK_ID --done doing --compact

# when a task is done, close it
vik modify $TASK_ID --done done
git commit ... # also commit the changes here, unless nothing changed

# for research tasks, add results as a comment.
# use `-` instead of text to if you want to read stdin.
# comments/descriptions are stored as html; pass --md to write markdown
# (converted to html for you via pandoc) and to read html back as markdown.
vik comment $TASK --md "comment goes here"

# you can also attach or download media with:
vik attach ...
vik attachments ...

# read comments on an existing ticket (add --md for markdown instead of html).
# this is useful in cases where we are exchanging feedback (but ideally we'll use matrix chat for that when available)
vik comments $ID --md

# poll the whole project for new replies since you last checked, to pick up
# followups. tracks the last-seen time in .vik-last-reply (per project dir); the
# first run just baselines (reports nothing) and later runs show what's new.
# your own comments are skipped; --no-update peeks without consuming.
vik replies --md
```
