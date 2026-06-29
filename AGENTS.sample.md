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
# note this is html, not markdown; pandoc is good for converting.
vik comment $TASK "comment goes here"

# you can also attach or download media with:
vik attach ...
vik attachments ...

# read comments on an existing ticket.
# this is useful in cases where we are exchanging feedback (but ideally we'll use matrix chat for that when available)
vik comments $ID
```
