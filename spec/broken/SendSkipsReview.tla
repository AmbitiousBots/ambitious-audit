---------------------------- MODULE SendSkipsReview ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Reports, MaxAttempts

VARIABLES state, reviewRequired, reviewed, failures, calls, requests, answers, stored

vars == <<state, reviewRequired, reviewed, failures, calls, requests, answers, stored>>

States == {"absent", "built", "reviewed", "sending", "sent", "acked", "failed"}

ReportIds == Reports \X (0..MaxAttempts)

ReportIdFor(r) == <<r, 0>>

TypeOK ==
  /\ state \in [Reports -> States]
  /\ reviewRequired \in [Reports -> BOOLEAN]
  /\ reviewed \in [Reports -> BOOLEAN]
  /\ failures \in [Reports -> 0..MaxAttempts]
  /\ calls \in [Reports -> 0..MaxAttempts]
  /\ requests \subseteq ReportIds
  /\ answers \subseteq ReportIds
  /\ stored \subseteq ReportIds

Init ==
  /\ state = [r \in Reports |-> "absent"]
  /\ reviewRequired = [r \in Reports |-> FALSE]
  /\ reviewed = [r \in Reports |-> FALSE]
  /\ failures = [r \in Reports |-> 0]
  /\ calls = [r \in Reports |-> 0]
  /\ requests = {}
  /\ answers = {}
  /\ stored = {}

Build(r) ==
  /\ state[r] = "absent"
  /\ \E needsReview \in BOOLEAN : reviewRequired' = [reviewRequired EXCEPT ![r] = needsReview]
  /\ state' = [state EXCEPT ![r] = "built"]
  /\ UNCHANGED <<reviewed, failures, calls, requests, answers, stored>>

Review(r) ==
  /\ state[r] = "built"
  /\ state' = [state EXCEPT ![r] = "reviewed"]
  /\ reviewed' = [reviewed EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<reviewRequired, failures, calls, requests, answers, stored>>

ReadyToSend(r) ==
  \/ state[r] = "built"
  \/ state[r] = "reviewed"

Call(r) ==
  /\ state' = [state EXCEPT ![r] = "sending"]
  /\ requests' = requests \cup {ReportIdFor(r)}
  /\ calls' = [calls EXCEPT ![r] = IF @ <= MaxAttempts THEN @ + 1 ELSE @]
  /\ UNCHANGED <<reviewRequired, reviewed, failures, answers, stored>>

StartSend(r) ==
  /\ ReadyToSend(r)
  /\ Call(r)

Retry(r) ==
  /\ state[r] = "failed"
  /\ failures[r] < MaxAttempts
  /\ Call(r)

ServiceStores(id) ==
  /\ id \in requests
  /\ stored' = stored \cup {id}
  /\ answers' = answers \cup {id}
  /\ UNCHANGED <<state, reviewRequired, reviewed, failures, calls, requests>>

SeeAnswer(r) ==
  /\ state[r] = "sending"
  /\ ReportIdFor(r) \in answers
  /\ state' = [state EXCEPT ![r] = "sent"]
  /\ UNCHANGED <<reviewRequired, reviewed, failures, calls, requests, answers, stored>>

Fail(r) ==
  /\ state[r] = "sending"
  /\ state' = [state EXCEPT ![r] = "failed"]
  /\ failures' = [failures EXCEPT ![r] = @ + 1]
  /\ UNCHANGED <<reviewRequired, reviewed, calls, requests, answers, stored>>

Ack(r) ==
  /\ state[r] = "sent"
  /\ state' = [state EXCEPT ![r] = "acked"]
  /\ UNCHANGED <<reviewRequired, reviewed, failures, calls, requests, answers, stored>>

Next ==
  \/ \E r \in Reports :
       Build(r) \/ Review(r) \/ StartSend(r) \/ Retry(r) \/ SeeAnswer(r) \/ Fail(r) \/ Ack(r)
  \/ \E id \in ReportIds : ServiceStores(id)

Fairness ==
  \A r \in Reports :
    /\ WF_vars(SeeAnswer(r) \/ Fail(r))
    /\ WF_vars(Retry(r))
    /\ WF_vars(Ack(r))

Spec == Init /\ [][Next]_vars /\ Fairness

StoredFor(r) == {id \in stored : id[1] = r}

RequestedFor(r) == {id \in requests : id[1] = r}

FailedFinal(r) == state[r] = "failed" /\ failures[r] = MaxAttempts

StoredAtMostOnce == \A r \in Reports : Cardinality(StoredFor(r)) <= 1

NoSendWithoutReview ==
  \A r \in Reports : (reviewRequired[r] /\ RequestedFor(r) # {}) => reviewed[r]

SentOnlyIfStored ==
  \A r \in Reports : state[r] \in {"sent", "acked"} => StoredFor(r) # {}

BoundedAttempts == \A r \in Reports : calls[r] <= MaxAttempts

RetriesConverge ==
  \A r \in Reports : (state[r] = "sending") ~> (state[r] = "acked" \/ FailedFinal(r))

=============================================================================
