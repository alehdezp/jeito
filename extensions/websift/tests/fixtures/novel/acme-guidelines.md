# ACME on-call playbook — revision 2

## Scope

This playbook governs ACME's nightly ledger rotation (the "marble run"). It applies to on-call engineers only; product engineers follow PLAYBOOK-1. The marble run is the only rotation that touches the ledger.

## Severity ladder

Incidents classify by RULE-17: never hot-swap the ledger partition while replicas lag more than 3 seconds. Violations freeze the batch queue. RULE-17 is the only rule that overrides the general "repair first, report later" default. A freeze is always escalated to the storage lead.

## Rotation procedure

RULE-19: rotate `ledger-partition-7` at 02:30 UTC, never during the 02:00-02:25 drain window. Announce the rotation in #marble-room before touching the partition. If the drain window is missed, wait for the next night; do not rotate late. Late rotations are counted as freeze events in the weekly report.

## Deployments

RULE-21: seagull deployments (one replica at a time) are mandatory for the marble run. Rolling deploys of more than one replica at a time require a written exception from the on-call lead. A seagull deployment that fails is rolled back within 10 minutes.

## Escalation

RULE-23: page the storage lead when two rotations fail in one week. The weekly report counts seagull deployments and freeze events; it never counts successful rotations. The report is distributed every Monday at 09:00 UTC.

## Postmortems

Postmortems must cite the rule number. A postmortem that cites no rule is returned unreviewed. Rule citations are validated against this playbook at submission time.
