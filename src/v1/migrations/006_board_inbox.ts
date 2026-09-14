export const boardInboxSql = `
CREATE TABLE board_subscription_threads (
  subscription_id TEXT NOT NULL REFERENCES board_subscriptions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  thread_id TEXT NOT NULL REFERENCES board_threads(id),
  start_sequence INTEGER NOT NULL CHECK (start_sequence >= 0),
  latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, thread_id),
  UNIQUE (project_id, subscription_id, thread_id)
) STRICT;

CREATE TABLE board_subscription_wakes (
  subscription_id TEXT PRIMARY KEY REFERENCES board_subscriptions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('session', 'user', 'desktop')),
  recipient_id TEXT NOT NULL,
  recipient_generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('read', 'pending', 'claimed', 'submitted', 'unconfirmed', 'undeliverable')),
  wake_revision INTEGER NOT NULL DEFAULT 0 CHECK (wake_revision >= 0),
  claimed_revision INTEGER CHECK (claimed_revision IS NULL OR claimed_revision >= 0),
  owner_generation TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  dirty_at TEXT,
  claimed_at TEXT,
  attempted_at TEXT,
  submitted_at TEXT,
  unconfirmed_at TEXT,
  undeliverable_at TEXT,
  read_at TEXT,
  last_error TEXT,
  UNIQUE (project_id, subscription_id)
) STRICT;

INSERT INTO board_subscription_threads(
  subscription_id,project_id,thread_id,start_sequence,latest_sequence,updated_at
)
SELECT s.id,s.project_id,t.id,
       COALESCE(c.last_sequence,0),
       COALESCE(MAX(CASE
         WHEN p.kind IN (SELECT value FROM json_each(s.event_kinds_json))
          AND NOT (p.source_author_kind=s.subscriber_kind
                   AND p.source_author_id=s.subscriber_id
                   AND COALESCE(p.source_author_generation,0)=COALESCE(s.subscriber_generation,0))
         THEN p.sequence ELSE 0 END),0),
       s.created_at
FROM board_subscriptions s
JOIN board_threads t ON t.project_id=s.project_id AND (s.thread_id IS NULL OR s.thread_id=t.id)
LEFT JOIN board_posts p ON p.project_id=t.project_id AND p.thread_id=t.id
LEFT JOIN board_read_cursors c
  ON c.project_id=s.project_id
 AND c.reader_kind=s.subscriber_kind
 AND c.reader_id=s.subscriber_id
 AND c.reader_generation=COALESCE(s.subscriber_generation,0)
 AND c.thread_id=t.id
GROUP BY s.id,t.id;

INSERT INTO board_subscription_wakes(
  subscription_id,project_id,recipient_kind,recipient_id,recipient_generation,
  state,wake_revision,next_attempt_at,dirty_at,read_at
)
SELECT s.id,s.project_id,s.subscriber_kind,s.subscriber_id,
       COALESCE(s.subscriber_generation,0),
       CASE
       WHEN s.deactivated_at IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM board_subscription_threads st
         WHERE st.subscription_id=s.id AND st.latest_sequence>st.start_sequence
       ) THEN 'read'
       WHEN EXISTS (
         SELECT 1 FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id
         WHERE e.subscription_id=s.id AND d.state IN ('claimed','unconfirmed')
       ) THEN 'unconfirmed'
       WHEN EXISTS (
         SELECT 1 FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id
         WHERE e.subscription_id=s.id AND d.state='acknowledged'
       ) AND NOT EXISTS (
         SELECT 1 FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id
         WHERE e.subscription_id=s.id AND d.state='pending'
       ) THEN 'submitted'
       ELSE 'pending' END,
       COALESCE((SELECT SUM(st.latest_sequence) FROM board_subscription_threads st
                 WHERE st.subscription_id=s.id),0),
       CASE WHEN s.deactivated_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id
         WHERE e.subscription_id=s.id AND d.state IN ('claimed','unconfirmed','acknowledged')
       ) AND EXISTS (
         SELECT 1 FROM board_subscription_threads st
         WHERE st.subscription_id=s.id AND st.latest_sequence>st.start_sequence
       ) THEN s.created_at ELSE NULL END,
       CASE WHEN s.deactivated_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id
         WHERE e.subscription_id=s.id AND d.state IN ('claimed','unconfirmed','acknowledged')
       ) AND EXISTS (
         SELECT 1 FROM board_subscription_threads st
         WHERE st.subscription_id=s.id AND st.latest_sequence>st.start_sequence
       ) THEN s.created_at ELSE NULL END,
       CASE WHEN s.deactivated_at IS NULL AND EXISTS (
         SELECT 1 FROM board_subscription_threads st
         WHERE st.subscription_id=s.id AND st.latest_sequence>st.start_sequence
       ) THEN NULL ELSE s.created_at END
FROM board_subscriptions s;

CREATE VIEW public_board_inboxes AS
SELECT w.subscription_id,w.project_id,w.recipient_kind,w.recipient_id,
       w.recipient_generation,w.state,w.wake_revision,w.claimed_revision,
       w.attempts,w.next_attempt_at,w.dirty_at,w.claimed_at,w.attempted_at,
       w.submitted_at,w.unconfirmed_at,w.undeliverable_at,w.read_at,w.last_error,
       (SELECT COUNT(*) FROM board_subscription_threads ist
        LEFT JOIN board_read_cursors ic
          ON ic.project_id=w.project_id AND ic.reader_kind=w.recipient_kind
         AND ic.reader_id=w.recipient_id AND ic.reader_generation=w.recipient_generation
         AND ic.thread_id=ist.thread_id
        WHERE ist.subscription_id=w.subscription_id AND EXISTS (
          SELECT 1 FROM board_posts ip JOIN board_subscriptions ins ON ins.id=w.subscription_id
          WHERE ip.project_id=w.project_id AND ip.thread_id=ist.thread_id
            AND ip.sequence>MAX(ist.start_sequence,COALESCE(ic.last_sequence,0))
            AND ip.sequence<=ist.latest_sequence
            AND ip.kind IN (SELECT value FROM json_each(ins.event_kinds_json))
            AND NOT (ip.source_author_kind=w.recipient_kind AND ip.source_author_id=w.recipient_id
                     AND COALESCE(ip.source_author_generation,0)=w.recipient_generation)
        )) AS unread_threads,
       (SELECT COUNT(*) FROM board_posts ip
        JOIN board_subscription_threads ist
          ON ist.subscription_id=w.subscription_id AND ist.project_id=ip.project_id AND ist.thread_id=ip.thread_id
        JOIN board_subscriptions ins ON ins.id=w.subscription_id
        LEFT JOIN board_read_cursors ic
          ON ic.project_id=w.project_id AND ic.reader_kind=w.recipient_kind
         AND ic.reader_id=w.recipient_id AND ic.reader_generation=w.recipient_generation
         AND ic.thread_id=ip.thread_id
        WHERE ip.project_id=w.project_id
          AND ip.sequence>MAX(ist.start_sequence,COALESCE(ic.last_sequence,0))
          AND ip.sequence<=ist.latest_sequence
          AND ip.kind IN (SELECT value FROM json_each(ins.event_kinds_json))
          AND NOT (ip.source_author_kind=w.recipient_kind AND ip.source_author_id=w.recipient_id
                   AND COALESCE(ip.source_author_generation,0)=w.recipient_generation)
       ) AS unread_posts
FROM board_subscription_wakes w
WHERE w.project_id=marionette_project_id();

CREATE VIEW public_watcher_owners AS
SELECT project_id,generation,process_identity,claimed_at,settled_at
FROM watcher_owners
WHERE project_id=marionette_project_id();

CREATE INDEX board_subscription_threads_by_project
ON board_subscription_threads(project_id,thread_id,subscription_id);

CREATE INDEX board_subscription_wakes_by_schedule
ON board_subscription_wakes(project_id,state,next_attempt_at,attempted_at,subscription_id);
`;
