# beads

this repo uses beads for task tracking. useful commands are:

```sh
# list tasks already in progress (in case you got interrupted)
bd list -s in_progress

# list tasks ready to start
bd ready

# claim a task
bd update -s in_progress $TASK

# when a task is done, close it (and commit unless there are no code changes)
bd close $TASK

# for research tasks, add results as a comment
bd comment $TASK
```
