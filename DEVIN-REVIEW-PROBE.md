# Automatic review enrollment probe

This temporary, documentation-only change verifies that automatic Devin Review
publishes a genuine commit status for a newly opened pull request.

It changes no application behavior, executable code, dependencies, or workflows.
No deployment or repository setting change is part of this probe.

The pull request is disposable: close it without merging after recording the
observed review status, then delete only its temporary remote branch.
