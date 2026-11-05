export const ORGANIZATIONAL_SCHEMA="DO $setup$\nBEGIN\n CREATE TABLE IF NOT EXISTS premiere_organizational_tickets(\n id uuid PRIMARY KEY,\n seat_id text NOT NULL UNIQUE REFERENCES premiere_seats(id) ON DELETE CASCADE,\n checked_in_at timestamptz,\n guest_name text,\n revoked boolean NOT NULL DEFAULT false\n );\n EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_seed_org_tickets(p_tickets jsonb) RETURNS integer LANGUAGE plpgsql AS $fn$\n DECLARE n integer;\n BEGIN\n  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;\n  IF now()>='2026-12-22 00:00 Europe/Warsaw'::timestamptz THEN RETURN 0;END IF;\n  IF jsonb_array_length(p_tickets)<>62 OR\n   (SELECT count(DISTINCT x.seat) FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text))<>62 OR\n   (SELECT count(DISTINCT x.id) FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text))<>62 OR\n   EXISTS(SELECT 1 FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text) LEFT JOIN premiere_seats s ON s.id=x.seat\n    WHERE x.id IS NULL OR s.id IS NULL OR s.row_no NOT BETWEEN 1 AND 5 OR s.pool<>'organizational' OR s.reservation_id IS NOT NULL)\n   THEN RAISE EXCEPTION 'INVALID_ORGANIZATIONAL_TICKETS';END IF;\n  INSERT INTO premiere_organizational_tickets(id,seat_id)\n   SELECT x.id,x.seat FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text)\n   ON CONFLICT(seat_id) DO NOTHING;\n  GET DIAGNOSTICS n=ROW_COUNT;RETURN n;\n END $fn$$create$;\n EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_checkin_org(p_ticket uuid,p_enter boolean)\n RETURNS TABLE(result text,guest_name text,person_no integer,admission text,seat_id text,entered_at timestamptz) LANGUAGE plpgsql AS $fn$\n DECLARE t premiere_organizational_tickets%ROWTYPE;seat premiere_seats%ROWTYPE;\n BEGIN\n  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;\n  SELECT * INTO t FROM premiere_organizational_tickets WHERE id=p_ticket FOR UPDATE;\n  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found',NULL::text,NULL::integer,NULL::text,NULL::text,NULL::timestamptz;RETURN;END IF;\n  SELECT * INTO seat FROM premiere_seats WHERE id=t.seat_id;\n  IF t.revoked OR seat.pool<>'organizational' OR seat.row_no NOT BETWEEN 1 AND 5 OR seat.reservation_id IS NOT NULL\n   OR now()>='2026-11-22 00:00 Europe/Warsaw'::timestamptz THEN\n   RETURN QUERY SELECT 'invalid','Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;RETURN;\n  END IF;\n  IF t.checked_in_at IS NOT NULL THEN RETURN QUERY SELECT 'used','Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;RETURN;END IF;\n  IF p_enter THEN UPDATE premiere_organizational_tickets SET checked_in_at=now() WHERE id=t.id RETURNING checked_in_at INTO t.checked_in_at;END IF;\n  RETURN QUERY SELECT CASE WHEN p_enter THEN 'entered' ELSE 'valid' END,'Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;\n END $fn$$create$;\nEND $setup$;\n";
const GUEST_LAYOUT_V2="DO $setup$\nBEGIN\n IF EXISTS (SELECT 1 FROM premiere_organizational_tickets WHERE seat_id='7-8') THEN RETURN; END IF;\n PERFORM premiere_expire();\n IF EXISTS (SELECT 1 FROM premiere_seats WHERE reservation_id IS NOT NULL\n  AND NOT (row_no=1 OR (row_no=7 AND seat_no<=5))) THEN\n  RAISE EXCEPTION 'GUEST_LAYOUT_HAS_RESERVATIONS';\n END IF;\n UPDATE premiere_seats SET pool=CASE WHEN row_no=1 OR (row_no=7 AND seat_no<=5)\n  THEN 'public' ELSE 'organizational' END;\n UPDATE premiere_organizational_tickets SET revoked=true WHERE seat_id LIKE '1-%';\n UPDATE premiere_config SET public_capacity=17, guest_capacity=66 WHERE id=1;\n EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_checkin_org(p_ticket uuid,p_enter boolean)\n RETURNS TABLE(result text,guest_name text,person_no integer,admission text,seat_id text,entered_at timestamptz) LANGUAGE plpgsql AS $fn$\n DECLARE t premiere_organizational_tickets%ROWTYPE;seat premiere_seats%ROWTYPE;\n BEGIN\n  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;\n  SELECT * INTO t FROM premiere_organizational_tickets WHERE id=p_ticket FOR UPDATE;\n  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found',NULL::text,NULL::integer,NULL::text,NULL::text,NULL::timestamptz;RETURN;END IF;\n  SELECT * INTO seat FROM premiere_seats WHERE id=t.seat_id;\n  IF t.revoked OR seat.pool<>'organizational' OR seat.reservation_id IS NOT NULL\n   OR now()>='2026-11-22 00:00 Europe/Warsaw'::timestamptz THEN\n   RETURN QUERY SELECT 'invalid','Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;RETURN;\n  END IF;\n  IF t.checked_in_at IS NOT NULL THEN RETURN QUERY SELECT 'used','Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;RETURN;END IF;\n  IF p_enter THEN UPDATE premiere_organizational_tickets SET checked_in_at=now() WHERE id=t.id RETURNING checked_in_at INTO t.checked_in_at;END IF;\n  RETURN QUERY SELECT CASE WHEN p_enter THEN 'entered' ELSE 'valid' END,'Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;\n END $fn$$create$;\nEND $setup$;";
const GUEST_ROW_ONE="DO $migration$\nBEGIN\n IF to_regclass('public.premiere_guest_row_one_applied') IS NOT NULL THEN RETURN; END IF;\n IF (SELECT count(*) FROM premiere_seats WHERE row_no=1 AND seat_no BETWEEN 1 AND 8\n     AND pool='held' AND reservation_id IS NULL)<>8 THEN\n  RAISE EXCEPTION 'ROW_ONE_NOT_AVAILABLE';\n END IF;\n UPDATE premiere_seats SET pool='organizational' WHERE row_no=1 AND seat_no BETWEEN 1 AND 8;\n INSERT INTO premiere_organizational_tickets(id,seat_id,revoked,checked_in_at,guest_name)\n SELECT x.id,x.seat,false,NULL,NULL\n FROM jsonb_to_recordset(current_setting('gola.row_one_manifest')::jsonb) AS x(id uuid,seat text)\n JOIN premiere_seats s ON s.id=x.seat AND s.row_no=1 AND s.seat_no BETWEEN 1 AND 8\n ON CONFLICT(seat_id) DO UPDATE SET id=excluded.id,revoked=false,checked_in_at=NULL,guest_name=NULL;\n IF (SELECT count(*) FROM premiere_organizational_tickets t JOIN premiere_seats s ON s.id=t.seat_id\n     WHERE s.row_no=1 AND s.seat_no BETWEEN 1 AND 8 AND NOT t.revoked)<>8 THEN\n  RAISE EXCEPTION 'INVALID_ROW_ONE_MANIFEST';\n END IF;\n UPDATE premiere_config SET\n  guest_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='organizational'),\n  public_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='public') WHERE id=1;\n CREATE TABLE premiere_guest_row_one_applied (id integer PRIMARY KEY);\nEND $migration$;";
export async function applyOrganizationalTickets(db){
 const [schema]=await db`SELECT to_regclass('public.premiere_organizational_tickets') IS NOT NULL AS installed`;
 if(!schema.installed)await db.transaction([db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,db.query(ORGANIZATIONAL_SCHEMA)]);
 const [names]=await db`SELECT EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='premiere_organizational_tickets' AND column_name='guest_name') AS installed`;
 if(!names.installed)await db`ALTER TABLE premiere_organizational_tickets ADD COLUMN IF NOT EXISTS guest_name text`;
 const layout=process.env.ORGANIZATIONAL_TICKETS_LAYOUT_V2;
 if(layout){
  if(new Date()>=new Date('2026-12-22T00:00:00+01:00'))return;
  const [version]=await db`SELECT EXISTS(SELECT 1 FROM premiere_organizational_tickets WHERE seat_id='7-8') AS installed`;
  if(!version.installed){
   await db.transaction([
    db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
    db.query(GUEST_LAYOUT_V2),
    db`INSERT INTO premiere_organizational_tickets(id,seat_id)
      SELECT x.id,x.seat FROM jsonb_to_recordset(${layout}::jsonb) AS x(id uuid,seat text)
      JOIN premiere_seats s ON s.id=x.seat WHERE s.pool='organizational'
      ON CONFLICT(seat_id) DO NOTHING`,
    db`SELECT 1 / CASE WHEN count(DISTINCT t.seat_id)=66 THEN 1 ELSE 0 END
      FROM jsonb_to_recordset(${layout}::jsonb) AS x(id uuid,seat text)
      JOIN premiere_organizational_tickets t ON t.id=x.id AND t.seat_id=x.seat
      JOIN premiere_seats s ON s.id=t.seat_id AND s.pool='organizational'`
   ]);
  }
  const rowOne=process.env.ORGANIZATIONAL_TICKETS_ROW_ONE;
  if(rowOne){
   const [applied]=await db`SELECT to_regclass('public.premiere_guest_row_one_applied') IS NOT NULL AS installed`;
   if(!applied.installed)await db.transaction([
    db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
    db`SELECT set_config('gola.row_one_manifest',${rowOne},true)`,
    db.query(GUEST_ROW_ONE)
   ]);
  }
  return;
 }
 if(process.env.ORGANIZATIONAL_TICKETS_JSON&&new Date()<new Date('2026-12-22T00:00:00+01:00')){
  const [count]=await db`SELECT count(*)::int AS n FROM premiere_organizational_tickets`;
  if(count.n<62)await db`SELECT premiere_seed_org_tickets(${process.env.ORGANIZATIONAL_TICKETS_JSON}::jsonb)`;
 }
}
