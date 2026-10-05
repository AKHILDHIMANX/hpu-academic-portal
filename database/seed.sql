-- =============================================================================
--  HPU ACADEMIC PORTAL -- DEMO DATASET
-- =============================================================================
--  Executed by the backend on first start (see backend/db/engine.py), and by
--  hand on Oracle with:  sqlplus hpu/hpu@HPU-CLUSTER-SHIMLA-01 @seed.sql
--
--  Everything below is deterministic: attendance and marks are derived from the
--  per-student performance ratio declared once in the *_RATIO source subquery,
--  so the portal always presents the same coherent numbers for a viva.
-- =============================================================================

-- ---------------------------------------------------------------- grade scale
INSERT INTO hpu_grade_scale (grade_letter, min_percent, max_percent, grade_point, classification) VALUES
  ('O',  90.00, 100.00, 10.0, 'OUTSTANDING'),
  ('A+', 80.00,  89.99,  9.0, 'EXCELLENT'),
  ('A',  70.00,  79.99,  8.0, 'VERY GOOD'),
  ('B+', 60.00,  69.99,  7.0, 'GOOD'),
  ('B',  50.00,  59.99,  6.0, 'SATISFACTORY'),
  ('C',  45.00,  49.99,  5.0, 'AVERAGE'),
  ('P',  40.00,  44.99,  4.0, 'PASS'),
  ('F',   0.00,  39.99,  0.0, 'FAIL');

-- ------------------------------------------------------------- auth accounts
-- hash = pbkdf2_hmac('sha256', password, unhexlify(salt), 240000)
INSERT INTO hpu_user_auth (user_id, user_code, email, phone, password_hash, password_salt, role, full_name, last_login_at) VALUES
  (1, 'HPU-CS-2023-882', 'akhil.dhiman@hpu.ac.in', '+91 98160 12345', '138fe5d737e2975e7a081685d0fb5c98a16f9318823c870407b49871a992fe99', 'b1f4c0e39a7d26851c4e0aa73f5d2b81', 'STUDENT', 'AKHIL DHIMAN', '2026-10-04 09:12:00'),
  (2, 'F-CS-02',          'prof.rsthakur@hpu.ac.in', '+91 177 2830915', 'a9be2a56dd0ab7ae364e114900b216aaddd9ecbbcae6633e6026bb218b3c2be5', 'c93a5e17b4d802f6a1c7e93b50d84f2a', 'TEACHER', 'PROF. R.S. THAKUR', '2026-10-04 08:45:00'),
  (3, 'ADMIN',            'admin@hpu.ac.in',         '+91 177 2830900', '248ad4c49deda5f743db5b77e2a2d54972c1ef2858baaf808a4421ac064c33cd', '5e2f1b8d07a3c496be81d0f74a2c6935', 'ADMIN',   'SYSTEM ADMINISTRATOR', '2026-10-04 07:30:00'),
  (4, 'HPU-CS-2023-883',  'priya.sharma@hpu.ac.in',  '+91 98160 54321', '138fe5d737e2975e7a081685d0fb5c98a16f9318823c870407b49871a992fe99', 'b1f4c0e39a7d26851c4e0aa73f5d2b81', 'STUDENT', 'PRIYA SHARMA',  '2026-09-29 16:40:00'),
  (5, 'HPU-CS-2023-884',  'rohit.verma@hpu.ac.in',   '+91 98160 54322', '138fe5d737e2975e7a081685d0fb5c98a16f9318823c870407b49871a992fe99', 'b1f4c0e39a7d26851c4e0aa73f5d2b81', 'STUDENT', 'ROHIT VERMA',   '2026-09-24 09:20:00');

-- ------------------------------------------------------------------- faculty
INSERT INTO hpu_teacher (teacher_id, faculty_code, full_name, designation, specialization, email, phone, office_location, office_hours, cabin_status, grading_deadline, warning_count, weekly_hours) VALUES
  (1, 'F-CS-01', 'DR. P.K. SHARMA',  'PROFESSOR & HEAD OF DEPARTMENT',           'THEORETICAL COMPUTER SCIENCE & AUTOMATA',            'pksharma@hpu.ac.in',   '+91 177 2830912', 'BLOCK A, ROOM 304, HPU SHIMLA',          '11:00 AM - 01:00 PM',              'IN CABIN',              '2026-10-12 23:59:00', 0, 10),
  (2, 'F-CS-02', 'PROF. R.S. THAKUR', 'SENIOR PROFESSOR & CHIEF EXAMINER',       'DATABASE SYSTEMS, PL/SQL & DISTRIBUTED TRANSACTIONS','prof.rsthakur@hpu.ac.in','+91 177 2830915', 'BLOCK A, ROOM 308, HPU SHIMLA',    '02:00 PM - 04:00 PM',              'ON CAMPUS',            '2026-10-05 23:59:00', 1, 14),
  (3, 'F-CS-03', 'DR. ANITA VERMA',  'ASSOCIATE PROFESSOR',                      'COMPUTER NETWORKS & CYBER SECURITY',               'anita.verma@hpu.ac.in', '+91 177 2830918', 'BLOCK B, ROOM 202, HPU SHIMLA',          '10:00 AM - 12:00 PM',              'IN LECTURE HALL 2',    '2026-10-14 23:59:00', 0, 12),
  (4, 'F-CS-04', 'DR. VIKAS KUMAR',  'ASSOCIATE PROFESSOR',                      'MACHINE LEARNING & DEEP NEURAL NETWORKS',           'vikas.kumar@hpu.ac.in', '+91 177 2830922', 'BLOCK B, ROOM 205, HPU SHIMLA',         '03:00 PM - 05:00 PM',              'IN AI RESEARCH LAB',   '2026-10-16 23:59:00', 0, 12),
  (5, 'F-CS-05', 'ER. SUMIT SHARMA', 'ASSISTANT PROFESSOR',                      'FULL-STACK WEB ENGINEERING & CLOUD SYSTEMS',        'sumit.sharma@hpu.ac.in','+91 177 2830925', 'BLOCK C, ROOM 104, HPU SHIMLA',         '01:00 PM - 03:00 PM',              'IN WEB DEV LAB',        '2026-10-18 23:59:00', 0, 11),
  (6, 'F-CS-06', 'DR. NEHA GUPTA',   'ASSISTANT PROFESSOR',                      'CLOUD COMPUTING & DISTRIBUTED SYSTEMS',            'neha.gupta@hpu.ac.in',  '+91 177 2830929', 'BLOCK C, ROOM 108, HPU SHIMLA',         '12:00 PM - 02:00 PM',              'IN CABIN',              '2026-10-20 23:59:00', 0, 9);

-- ------------------------------------------------------------------- courses
INSERT INTO hpu_course (course_id, course_code, course_name, credits, semester, instructor_id, syllabus_file, topics) VALUES
  (1, 'CS-601', 'ADVANCED DATABASE SYSTEMS & PL/SQL',           4, 6, 2, 'SYLLABUS_CS601.pdf', '["RELATIONAL ALGEBRA & NORMALISATION","PL/SQL TRIGGERS & PACKAGES","DISTRIBUTED TRANSACTIONS & 2PC","SHARDING & NOSQL ARCHITECTURE","QUERY OPTIMISATION & INDEXING"]'),
  (2, 'CS-602', 'COMPUTER NETWORKS & CYBER SECURITY',           4, 6, 3, 'SYLLABUS_CS602.pdf', '["TCP/IP STACK & BGP ROUTING","RSA, AES & PUBLIC KEY INFRASTRUCTURE","TLS 1.3 HANDSHAKE PROTOCOL","FIREWALLS, IDS & INTRUSION PREVENTION"]'),
  (3, 'CS-603', 'MACHINE LEARNING & AI SYSTEMS',                 4, 6, 4, 'SYLLABUS_CS603.pdf', '["SUPERVISED & UNSUPERVISED LEARNING","DEEP NEURAL NETWORKS","CONVOLUTIONAL & TRANSFORMER MODELS","MODEL DEPLOYMENT & EVALUATION"]'),
  (4, 'CS-604', 'FULL-STACK WEB ENGINEERING',                    3, 6, 5, 'SYLLABUS_CS604.pdf', '["MODERN FRONTEND ARCHITECTURE","RESTFUL SERVICES & AUTHENTICATION","PERFORMANCE OPTIMISATION & CACHING","SECURE DEPLOYMENT PRACTICES"]'),
  (5, 'CS-605', 'CLOUD COMPUTING ARCHITECTURE',                  3, 6, 6, 'SYLLABUS_CS605.pdf', '["VIRTUALISATION & HYPERVISORS","CONTAINERISATION (DOCKER / K8S)","MICROSERVICES & SERVICE MESHES","SERVERLESS COMPUTING"]'),
  (6, 'CS-606', 'HIGH PERFORMANCE GRAPHICS LAB',                 2, 6, 2, 'SYLLABUS_CS606.pdf', '["GPU SHADER PROGRAMMING","RAY TRACING ALGORITHMS","PARALLEL PIPELINES","OPENGL & VULKAN RENDER PIPELINE"]');

-- -------------------------------------------------- teacher course allocations
INSERT INTO hpu_teacher_allocation (teacher_id, course_id, batch_code, semester) VALUES
  (2, 1, 'CSE-2023-BATCH-A', 6),
  (2, 6, 'CSE-2023-BATCH-A', 6),
  (3, 2, 'CSE-2023-BATCH-A', 6),
  (4, 3, 'CSE-2023-BATCH-A', 6),
  (5, 4, 'CSE-2023-BATCH-A', 6),
  (6, 5, 'CSE-2023-BATCH-A', 6);

-- --------------------------------------------------- students (24, batch A)
INSERT INTO hpu_student (student_id, roll_no, reg_no, first_name, last_name, email, phone, semester, batch_code, academic_status, attendance_lock, advisor, avatar_url) VALUES
  ( 1, 'HPU-CS-2023-881', '18-HPU-10292', 'AARAV',          'SHARMA',      'aarav.sharma@hpu.ac.in',   '+91 98160 12301', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  ( 2, 'HPU-CS-2023-882', '18-HPU-10293', 'AKHIL',          'DHIMAN',      'akhil.dhiman@hpu.ac.in',   '+91 98160 12345', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    0, 'DR. P.K. SHARMA (HOD CSE)', 'akhil-dhiman.jpg'),
  ( 3, 'HPU-CS-2023-883', '18-HPU-10294', 'PRIYA',          'SHARMA',      'priya.sharma@hpu.ac.in',   '+91 98160 54321', 6, 'CSE-2023-BATCH-A', 'DETAINED',  1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  ( 4, 'HPU-CS-2023-884', '18-HPU-10295', 'ROHIT',          'VERMA',       'rohit.verma@hpu.ac.in',    '+91 98160 54322', 6, 'CSE-2023-BATCH-A', 'SUSPENDED', 1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  ( 5, 'HPU-CS-2023-885', '18-HPU-10296', 'ANANYA',         'CHAUHAN',     'ananya.chauhan@hpu.ac.in', '+91 98160 12304', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    0, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  ( 6, 'HPU-CS-2023-886', '18-HPU-10297', 'SAHIL',          'THAKUR',      'sahil.thakur@hpu.ac.in',   '+91 98160 12305', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  ( 7, 'HPU-CS-2023-887', '18-HPU-10298', 'ISHITA',         'RANA',        'ishita.rana@hpu.ac.in',    '+91 98160 12306', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  ( 8, 'HPU-CS-2023-888', '18-HPU-10299', 'VIKRAMADITYA',   'SINGH',       'vikramaditya@hpu.ac.in',   '+91 98160 12307', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  ( 9, 'HPU-CS-2023-889', '18-HPU-10300', 'MEHAK',          'DOGRA',       'mehak.dogra@hpu.ac.in',    '+91 98160 12308', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (10, 'HPU-CS-2023-890', '18-HPU-10301', 'KARAN',          'KAPOOR',      'karan.kapoor@hpu.ac.in',   '+91 98160 12309', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (11, 'HPU-CS-2023-891', '18-HPU-10302', 'SIMRAN',         'KAUR',        'simran.kaur@hpu.ac.in',    '+91 98160 12310', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (12, 'HPU-CS-2023-892', '18-HPU-10303', 'RAHUL',          'CHANDEL',     'rahul.chandel@hpu.ac.in',  '+91 98160 12311', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (13, 'HPU-CS-2023-893', '18-HPU-10304', 'DIVYA',          'BHARTI',      'divya.bharti@hpu.ac.in',   '+91 98160 12312', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (14, 'HPU-CS-2023-894', '18-HPU-10305', 'ABHINAV',        'SOOD',        'abhinav.sood@hpu.ac.in',   '+91 98160 12313', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (15, 'HPU-CS-2023-895', '18-HPU-10306', 'SHREYA',         'PATHANIA',    'shreya.pathania@hpu.ac.in','+91 98160 12314', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (16, 'HPU-CS-2023-896', '18-HPU-10307', 'PANKAJ',         'JASWAL',      'pankaj.jaswal@hpu.ac.in',  '+91 98160 12315', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (17, 'HPU-CS-2023-897', '18-HPU-10308', 'TANVI',          'GULERIA',     'tanvi.guleria@hpu.ac.in',  '+91 98160 12316', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (18, 'HPU-CS-2023-898', '18-HPU-10309', 'ADITYA',         'KASHYAP',     'aditya.kashyap@hpu.ac.in', '+91 98160 12317', 6, 'CSE-2023-BATCH-A', 'DETAINED',  1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (19, 'HPU-CS-2023-899', '18-HPU-10310', 'NEHA',           'KANWAR',      'neha.kanwar@hpu.ac.in',    '+91 98160 12318', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (20, 'HPU-CS-2023-900', '18-HPU-10311', 'VARUN',          'MANKOTIA',    'varun.mankotia@hpu.ac.in', '+91 98160 12319', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (21, 'HPU-CS-2023-901', '18-HPU-10312', 'GAURAV',         'THAKUR',      'gaurav.thakur@hpu.ac.in',  '+91 98160 12320', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (22, 'HPU-CS-2023-902', '18-HPU-10313', 'SNEHA',          'PATIAL',      'sneha.patial@hpu.ac.in',   '+91 98160 12321', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (23, 'HPU-CS-2023-903', '18-HPU-10314', 'ARJUN',          'NEGI',        'arjun.negi@hpu.ac.in',     '+91 98160 12322', 6, 'CSE-2023-BATCH-A', 'DETAINED',  1, 'DR. P.K. SHARMA (HOD CSE)', NULL),
  (24, 'HPU-CS-2023-904', '18-HPU-10315', 'PALAK',          'SHARMA',      'palak.sharma@hpu.ac.in',   '+91 98160 12323', 6, 'CSE-2023-BATCH-A', 'ACTIVE',    1, 'DR. P.K. SHARMA (HOD CSE)', NULL);

-- -------------------------------------------------------------- enrollments
-- Single-batch department: every student is enrolled in every course.
INSERT INTO hpu_enrollment (student_id, course_id)
SELECT s.student_id, c.course_id
  FROM hpu_student s CROSS JOIN hpu_course c;

-- ------------------------------------------------------------- ATTENDANCE
-- Derived: per-student performance ratio (declared once) x per-course lecture
-- count, with a small deterministic jitter so subject percentages differ.
INSERT INTO hpu_attendance (student_id, course_id, total_lectures, attended_lectures, last_session_date)
SELECT src.student_id,
       src.course_id,
       src.total,
       MIN(src.total, CAST(ROUND(src.total * src.ratio / 100.0) AS INTEGER)),
       '2026-10-02'
FROM (
    SELECT e.student_id,
           e.course_id,
           CASE c.course_code
               WHEN 'CS-601' THEN 45 WHEN 'CS-602' THEN 40 WHEN 'CS-603' THEN 48
               WHEN 'CS-604' THEN 35 WHEN 'CS-605' THEN 42 WHEN 'CS-606' THEN 24
           END AS total,
           ( CASE e.student_id
                WHEN  1 THEN 93.0 WHEN  2 THEN 91.0 WHEN  3 THEN 62.0 WHEN  4 THEN 45.0
                WHEN  5 THEN 96.0 WHEN  6 THEN 87.0 WHEN  7 THEN 89.0 WHEN  8 THEN 84.0
                WHEN  9 THEN 97.0 WHEN 10 THEN 78.0 WHEN 11 THEN 91.0 WHEN 12 THEN 80.0
                WHEN 13 THEN 93.0 WHEN 14 THEN 82.0 WHEN 15 THEN 95.0 WHEN 16 THEN 75.0
                WHEN 17 THEN 89.0 WHEN 18 THEN 69.0 WHEN 19 THEN 98.0 WHEN 20 THEN 86.0
                WHEN 21 THEN 88.0 WHEN 22 THEN 92.0 WHEN 23 THEN 71.0 WHEN 24 THEN 94.0
             END
             + ((e.student_id * 3 + e.course_id * 5) % 7) - 3
           ) AS ratio
      FROM hpu_enrollment e
      JOIN hpu_course c ON c.course_id = e.course_id
) AS src;

-- --------------------------------------------- attendance session audit trail
INSERT INTO hpu_attendance_session
       (session_id, course_id, teacher_id, session_date, slot, batch_code, total_students, present_count, absent_count, late_count, is_revised, created_at)
VALUES
  (1, 1, 2, '2026-10-02', '10:00 AM - 11:00 AM', 'CSE-2023-BATCH-A', 24, 22, 2, 1, 0, '2026-10-02 10:05:00'),
  (2, 1, 2, '2026-10-01', '10:00 AM - 11:00 AM', 'CSE-2023-BATCH-A', 24, 23, 1, 0, 0, '2026-10-01 10:04:00'),
  (3, 1, 2, '2026-09-30', '10:00 AM - 11:00 AM', 'CSE-2023-BATCH-A', 24, 24, 0, 0, 0, '2026-09-30 10:03:00'),
  (4, 1, 2, '2026-09-29', '11:15 AM - 12:15 PM', 'CSE-2023-BATCH-A', 24, 21, 3, 2, 0, '2026-09-29 11:20:00'),
  (5, 6, 2, '2026-09-30', '02:00 PM - 05:00 PM', 'CSE-2023-BATCH-A', 24, 22, 2, 0, 0, '2026-09-30 14:10:00');

-- ------------------------------------------------------------- COLLEGIA MARKS
-- Same ratio source, with a per-course difficulty offset so the transcript
-- shows a realistic spread of grades instead of six identical O grades.
INSERT INTO hpu_mark (student_id, course_id, internal_marks, midterm_marks, endterm_marks, total_marks, updated_by)
SELECT student_id, course_id, internal, midterm, endterm, internal + midterm + endterm, 'SEED'
FROM (
    SELECT e.student_id,
           e.course_id,
           MIN(20.0, ROUND(MAX(0.0, 20.0 * s.ratio / 100.0 + ((e.student_id * 3 + e.course_id) % 5) - 2), 1)) AS internal,
           MIN(30.0, ROUND(MAX(0.0, 30.0 * s.ratio / 100.0 + ((e.student_id * 7 + e.course_id * 3) % 6) - 2), 1)) AS midterm,
           MIN(50.0, ROUND(MAX(0.0, 50.0 * s.ratio / 100.0 + d.difficulty + ((e.student_id * 11 + e.course_id * 13) % 7) - 3), 1)) AS endterm
      FROM hpu_enrollment e
      JOIN (
            SELECT 1 AS course_id,  0.0 AS difficulty UNION ALL
            SELECT 2,              -6.0 UNION ALL
            SELECT 3,               1.0 UNION ALL
            SELECT 4,              -2.0 UNION ALL
            SELECT 5,              -8.0 UNION ALL
            SELECT 6,               2.0
      ) AS d ON d.course_id = e.course_id
      JOIN (
            SELECT 1  AS student_id, 93.0 AS ratio UNION ALL SELECT 2,  91.0 UNION ALL
            SELECT 3,  62.0 UNION ALL SELECT 4,  45.0 UNION ALL SELECT 5,  96.0 UNION ALL
            SELECT 6,  87.0 UNION ALL SELECT 7,  89.0 UNION ALL SELECT 8,  84.0 UNION ALL
            SELECT 9,  97.0 UNION ALL SELECT 10, 78.0 UNION ALL SELECT 11, 91.0 UNION ALL
            SELECT 12, 80.0 UNION ALL SELECT 13, 93.0 UNION ALL SELECT 14, 82.0 UNION ALL
            SELECT 15, 95.0 UNION ALL SELECT 16, 75.0 UNION ALL SELECT 17, 89.0 UNION ALL
            SELECT 18, 69.0 UNION ALL SELECT 19, 98.0 UNION ALL SELECT 20, 86.0 UNION ALL
            SELECT 21, 88.0 UNION ALL SELECT 22, 92.0 UNION ALL SELECT 23, 71.0 UNION ALL
            SELECT 24, 94.0
      ) AS s ON s.student_id = e.student_id
) AS raw;

-- Drop the derived columns used only for readability, then resolve grades.
UPDATE hpu_mark
   SET grade_letter = (SELECT g.grade_letter FROM hpu_grade_scale g
                        WHERE hpu_mark.total_marks >= g.min_percent
                          AND hpu_mark.total_marks <= g.max_percent),
       grade_point  = (SELECT g.grade_point  FROM hpu_grade_scale g
                        WHERE hpu_mark.total_marks >= g.min_percent
                          AND hpu_mark.total_marks <= g.max_percent);

-- --------------------------------------------------------- previous year papers
INSERT INTO hpu_pyq_paper (paper_id, course_code, subject_name, year, exam_type, file_url, downloads) VALUES
  (1, 'CS-601', 'ADVANCED DATABASE SYSTEMS & PL/SQL',              2025, 'END-TERM FINAL', 'PYQ_CS601_2025.pdf', 482),
  (2, 'CS-602', 'COMPUTER NETWORKS & CRYPTOGRAPHY',               2025, 'END-TERM FINAL', 'PYQ_CS602_2025.pdf', 612),
  (3, 'CS-603', 'MACHINE LEARNING & DEEP NEURAL NETWORKS',        2024, 'MID-TERM EXAM',   'PYQ_CS603_2024.pdf', 389),
  (4, 'CS-604', 'FULL-STACK WEB ENGINEERING',                     2025, 'END-TERM FINAL', 'PYQ_CS604_2025.pdf', 254),
  (5, 'CS-601', 'DISTRIBUTED DATABASES & TWO-PHASE COMMIT',        2024, 'END-TERM FINAL', 'PYQ_CS601_2024.pdf', 431),
  (6, 'CS-606', 'COMPUTER GRAPHICS PIPELINES & RAY TRACING',       2025, 'END-TERM FINAL', 'PYQ_CS606_2025.pdf', 197);

-- ------------------------------------------------------------ exam date sheet
INSERT INTO hpu_exam_schedule
       (schedule_id, notification_no, course_code, subject_name, exam_date, exam_day, start_time, end_time, venue, exam_type)
VALUES
  (1, 'HPU/EXAM/BTECH-CSE/2026/089', 'CS-601', 'ADVANCED DATABASE SYSTEMS',            '2026-11-15', 'MONDAY',    '10:00 AM', '01:00 PM', 'MAIN AUDITORIUM (HALL 1)', 'THEORY'),
  (2, 'HPU/EXAM/BTECH-CSE/2026/089', 'CS-602', 'COMPUTER NETWORKS & CYBER SECURITY',   '2026-11-18', 'THURSDAY',  '10:00 AM', '01:00 PM', 'MAIN AUDITORIUM (HALL 1)', 'THEORY'),
  (3, 'HPU/EXAM/BTECH-CSE/2026/089', 'CS-603', 'MACHINE LEARNING & AI SYSTEMS',        '2026-11-21', 'SUNDAY',    '10:00 AM', '01:00 PM', 'CENTRAL HALL 2',            'THEORY'),
  (4, 'HPU/EXAM/BTECH-CSE/2026/089', 'CS-604', 'FULL-STACK WEB ENGINEERING',           '2026-11-24', 'WEDNESDAY', '10:00 AM', '01:00 PM', 'LAB COMPLEX A (HALL 3)',    'THEORY'),
  (5, 'HPU/EXAM/BTECH-CSE/2026/089', 'CS-605', 'CLOUD COMPUTING ARCHITECTURE',         '2026-11-27', 'SATURDAY',  '10:00 AM', '01:00 PM', 'CENTRAL HALL 2',            'THEORY'),
  (6, 'HPU/EXAM/BTECH-CSE/2026/089', 'CS-606', 'HIGH PERFORMANCE GRAPHICS LAB',        '2026-11-30', 'TUESDAY',   '09:30 AM', '04:30 PM', 'GRAPHICS LAB & LAB 3',      'PRACTICAL');

-- ----------------------------------------------------------------- worksheets
INSERT INTO hpu_worksheet (worksheet_id, course_code, title, batch_code, max_marks, deadline_date, attachment_url, created_by) VALUES
  (1, 'CS-601', 'WORKSHEET 01: PL/SQL TRIGGERS & DISTRIBUTED TRANSACTIONS',      'CSE-2023-BATCH-A', 20, '2026-10-15 23:59:00', 'HPU_WORKSHEET_TEMPLATE.pdf', 'PROF. R.S. THAKUR'),
  (2, 'CS-602', 'WORKSHEET 02: CRYPTOGRAPHIC HANDSHAKE & TLS PROTOCOLS',       'CSE-2023-BATCH-A', 20, '2026-10-18 23:59:00', 'HPU_WORKSHEET_TEMPLATE.pdf', 'DR. ANITA VERMA'),
  (3, 'CS-603', 'WORKSHEET 03: CONVOLUTIONAL NEURAL NETWORKS LAB ASSIGNMENT',   'CSE-2023-BATCH-A', 20, '2026-10-22 23:59:00', 'HPU_WORKSHEET_TEMPLATE.pdf', 'DR. VIKAS KUMAR'),
  (4, 'CS-604', 'WORKSHEET 04: REST API AUTHENTICATION & SESSION SECURITY',    'CSE-2023-BATCH-A', 20, '2026-10-26 23:59:00', 'HPU_WORKSHEET_TEMPLATE.pdf', 'ER. SUMIT SHARMA'),
  (5, 'CS-605', 'WORKSHEET 05: KUBERNETES ORCHESTRATION & SERVICE MESHES',     'CSE-2023-BATCH-A', 20, '2026-10-30 23:59:00', 'HPU_WORKSHEET_TEMPLATE.pdf', 'DR. NEHA GUPTA');

-- ------------------------------------------------------- worksheet submissions
INSERT INTO hpu_worksheet_submission
       (submission_id, worksheet_id, student_id, submitted_file, submitted_at, evaluation_status, obtained_marks, teacher_remarks, evaluated_by, evaluated_at)
VALUES
  (1, 1,  2, 'AKHIL_DHIMAN_CS601_WORKSHEET1.PDF', '2026-09-29 14:30:00', 'CHECKED & GRADED', 19.5, 'EXCELLENT PL/SQL TRIGGER LOGIC AND CLEAN DIAGRAMS.',        'PROF. R.S. THAKUR', '2026-10-01 16:20:00'),
  (2, 1,  1, 'AARAV_SHARMA_CS601_WORKSHEET1.PDF',   '2026-09-29 15:10:00', 'CHECKED & GRADED', 18.0, 'STRONG NORMALISATION SECTION; REVISE THE 2PC DIAGRAM.',      'PROF. R.S. THAKUR', '2026-10-01 16:35:00'),
  (3, 1,  3, 'PRIYA_SHARMA_CS601_WORKSHEET1.PDF',   '2026-09-30 09:05:00', 'UNDER EVALUATION', NULL, 'SUBMISSION RECEIVED. EVALUATION IN PROGRESS.',            NULL,               NULL),
  (4, 1,  4, 'ROHIT_VERMA_CS601_WORKSHEET1.PDF',    '2026-09-30 10:40:00', 'UNDER EVALUATION', NULL, 'SUBMISSION RECEIVED. EVALUATION IN PROGRESS.',            NULL,               NULL),
  (5, 2,  2, 'AKHIL_DHIMAN_CS602_WORKSHEET2.PDF',   '2026-09-30 10:15:00', 'CHECKED & GRADED', 17.0, 'GOOD TLS HANDSHAKE TRACE; MISSING THE CERTIFICATE PINNING NOTE.', 'DR. ANITA VERMA', '2026-10-02 12:10:00'),
  (6, 2,  5, 'ANANYA_CHAUHAN_CS602_WORKSHEET2.PDF', '2026-09-30 11:02:00', 'SUBMITTED',        NULL, 'AWAITING EVALUATION BY DR. ANITA VERMA.',                   NULL,               NULL),
  (7, 2,  9, 'MEHAK_DOGRA_CS602_WORKSHEET2.PDF',    '2026-10-01 08:45:00', 'SUBMITTED',        NULL, 'AWAITING EVALUATION BY DR. ANITA VERMA.',                   NULL,               NULL),
  (8, 3,  2, 'AKHIL_DHIMAN_CS603_WORKSHEET3.PDF',   '2026-10-02 20:05:00', 'CHECKED & GRADED', 18.5, 'SOUND CNN IMPLEMENTATION; INCLUDE THE POOLING DERIVATION.',   'DR. VIKAS KUMAR',  '2026-10-03 11:00:00'),
  (9, 3,  6, 'SAHIL_THAKUR_CS603_WORKSHEET3.PDF',   '2026-10-03 09:12:00', 'SUBMITTED',        NULL, 'AWAITING EVALUATION BY DR. VIKAS KUMAR.',                  NULL,               NULL);

-- ----------------------------------------------------------------- e-library
INSERT INTO hpu_e_library (library_id, title, authors, category, subject, publisher, file_url, page_count, rating, description) VALUES
  (1, 'DATABASE SYSTEM CONCEPTS (7TH EDITION)', 'ABRAHAM SILBERSCHATZ, HENRY F. KORTH, S. SUDARSHAN', 'TEXTBOOK',      'CS-601',       'MCGRAW-HILL',                 'DATABASE_SYSTEM_CONCEPTS_7E.PDF',   1376, 4.9, 'THE BENCHMARK TEXTBOOK COVERING RELATIONAL ALGEBRA, PL/SQL, TRANSACTIONS AND SHARDING ARCHITECTURE.'),
  (2, 'COMPUTER NETWORKING: A TOP-DOWN APPROACH (8TH ED)', 'JAMES F. KUROSE, KEITH W. ROSS',              'TEXTBOOK',      'CS-602',       'PEARSON',                      'COMPUTER_NETWORKING_TOP_DOWN_8E.PDF', 848, 4.8, 'COMPREHENSIVE COVERAGE OF THE APPLICATION LAYER, TRANSPORT LAYER, TLS CRYPTOGRAPHY AND SDN.'),
  (3, 'PATTERN RECOGNITION AND MACHINE LEARNING', 'CHRISTOPHER M. BISHOP',                        'REFERENCE',     'CS-603',       'SPRINGER',                    'PATTERN_RECOGNITION_ML_BISHOP.PDF',   758, 5.0, 'FOUNDATIONAL MATHEMATICS FOR BAYESIAN INFERENCE, GRAPHICAL MODELS AND DEEP LEARNING ARCHITECTURES.'),
  (4, 'FULL-STACK CLOUD ARCHITECTURES & REST APIS', 'DR. NEHA GUPTA & ER. SUMIT SHARMA',          'LECTURE NOTES', 'CS-604/605',  'HPU CS DEPARTMENT PRESS',     'HPU_CLOUD_WEB_LECTURE_NOTES.PDF',     312, 4.7, 'OFFICIAL HPU COMPILED NOTES FOR DISTRIBUTED MICROSERVICES, DOCKER CONTAINERS AND REST API DESIGN.'),
  (5, 'DISTRIBUTED DATABASE CONCURRENCY CONTROL & RECOVERY', 'PROF. R.S. THAKUR (HPU CHIEF EXAMINER)', 'RESEARCH PAPER','CS-601',     'IEEE TRANSACTIONS ON KNOWLEDGE AND DATA ENGINEERING', 'IEEE_TKDE_THAKUR_DISTRIBUTED_DB.PDF', 18, 4.9, 'PEER-REVIEWED PAPER ON TWO-PHASE COMMIT OPTIMISATION IN CLUSTER COMPUTING.'),
  (6, 'HPU B.TECH CSE SEMESTER VI LAB MANUAL & PROTOCOLS', 'DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING, HPU', 'LAB MANUAL', 'CS-606', 'HPU ACADEMIC COUNCIL',         'HPU_SEM6_LAB_MANUAL_2026.PDF',       142, 4.8, 'OFFICIAL EXPERIMENTAL PROTOCOLS FOR ADVANCED DATABASE AND GRAPHICS LABORATORY ASSIGNMENTS.'),
  (7, 'PARALLEL PROGRAMMING WITH CUDA', 'DAVID B. KIRK & WEN-MEI W. HWANG',                     'REFERENCE',     'CS-606',       'ELSEVIER',                     'PARALLEL_PROGRAMMING_CUDA.pdf',        592, 4.6, 'CUDA THREADING MODEL, SHADER OPTIMISATION AND GPU PERFORMANCE ANALYSIS.'),
  (8, 'DESIGNING DATA-INTENSIVE APPLICATIONS', 'MARTIN KLEPPMANN',                               'TEXTBOOK',      'CS-601',       "O'REILLY",                     'DESIGNING_DATA_INTENSIVE_APPS.pdf',  616, 4.9, 'REPLICATION, PARTITIONING, TRANSACTIONS AND CONSISTENCY AT SCALE.');

-- ------------------------------------------------------------------ templates
INSERT INTO hpu_e_library (library_id, title, authors, category, subject, publisher, file_url, page_count, rating, description) VALUES
  (9,  'HPU OFFICIAL ASSIGNMENT & WORKSHEET COVER PAGE',   'HPU EXAMINATION CELL', 'TEMPLATE',      'GENERAL', 'HPU ACADEMIC COUNCIL', 'HPU_OFFICIAL_COVER_PAGE_TEMPLATE.pdf', 2, 5.0, 'OFFICIAL HIMACHAL PRADESH UNIVERSITY EMBLEM COVER PAGE FOR B.TECH CSE SUBMISSIONS.'),
  (10, 'HPU SUBJECT WORKSHEET SOLUTION FORMAT SHEET',      'HPU EXAMINATION CELL', 'TEMPLATE',      'GENERAL', 'HPU ACADEMIC COUNCIL', 'HPU_WORKSHEET_FORMAT_SHEET.pdf',     2, 5.0, 'STANDARD LAB AND THEORY WORKSHEET WRITING FORMAT WITH A MARKS GRID.');

-- --------------------------------------------------------------------- notices
INSERT INTO hpu_notice (notice_id, issued_on, category, title, summary, issued_by, is_pinned) VALUES
  (101, '2026-10-02', 'EXAM DATE SHEET',  'FINAL SCHEDULE FOR B.TECH SEMESTER VI EXAMINATIONS 2026',  'THE END-TERM THEORY EXAMINATIONS FOR B.TECH CSE SEMESTER VI WILL COMMENCE FROM NOVEMBER 15, 2026. ALL CANDIDATES MUST REPORT 30 MINUTES BEFORE EACH PAPER.', 'HPU EXAMINATION CELL', 1),
  (102, '2026-09-28', 'ACADEMIC CIRCULAR', 'WORKSHEET SUBMISSION DEADLINE NOTICE FOR BATCH 2023',   'ALL B.TECH CSE SEMESTER VI STUDENTS ARE DIRECTED TO SUBMIT WORKSHEETS 01 TO 04 BEFORE THE RESPECTIVE EXPIRY DEADLINE. LATE SUBMISSIONS WILL BE PENALISED.', 'DR. P.K. SHARMA (HOD CSE)', 1),
  (103, '2026-09-25', 'ATTENDANCE',        'MINIMUM 75% ATTENDANCE REQUIREMENT REMINDER',          'AS PER UNIVERSITY REGULATIONS, STUDENTS WITH LESS THAN 75% OVERALL ATTENDANCE ARE NOT ELIGIBLE TO SIT END-TERM EXAMINATIONS AND WILL BE DETAINED.', 'DR. P.K. SHARMA (HOD CSE)', 0),
  (104, '2026-09-20', 'LIBRARY',           'E-LIBRARY SUBSCRIPTION RENEWED FOR 2026-27',            'THE DEPARTMENTAL E-LIBRARY NOW OFFERS 260+ TITLES ACROSS ALL SEMESTER COURSES. ACCESS IS AVAILABLE THROUGH THE PORTAL UNDER THE E-LIBRARY TAB.', 'DEPARTMENT OF COMPUTER SCIENCE', 0),
  (105, '2026-09-18', 'LAB INSTRUCTIONS',  'GRAPHICS LAB (CS-606) HARDWARE ALLOCATION',            'STUDENTS MUST REPORT TO THE GRAPHICS LAB IN BLOCK D FOR THE PRACTICAL EXAMINATION. PERSONAL LAPTOPS ARE NOT PERMITTED INSIDE THE LAB.', 'ER. SUMIT SHARMA', 0);

-- ---------------------------------------------------------------- audit trail
INSERT INTO hpu_audit_log (log_id, actor_role, actor_name, actor_code, action, target, details, ip_address, severity, created_at) VALUES
  (1, 'ADMIN',   'SYSTEM ADMINISTRATOR', 'ADMIN',           'SYSTEM_SEED',          NULL,                                 'DATABASE SCHEMA MIGRATED AND SEEDED FROM seed.sql',                  '10.0.0.1', 'INFO',     '2026-10-04 07:30:00'),
  (2, 'ADMIN',   'SYSTEM ADMINISTRATOR', 'ADMIN',           'PORTAL_UNLOCK',        'CSE-2023-BATCH-A',                    'ATTENDANCE PORTAL UNLOCKED FOR BATCH CSE-2023-BATCH-A',               '10.0.0.1', 'INFO',     '2026-10-03 10:12:00'),
  (3, 'ADMIN',   'SYSTEM ADMINISTRATOR', 'ADMIN',           'STUDENT_STATUS_UPDATE','HPU-CS-2023-883 / PRIYA SHARMA',      'ACADEMIC_STATUS SET TO DETAINED (OVERALL ATTENDANCE 62.2%)',          '10.0.0.1', 'WARNING', '2026-10-03 10:14:00'),
  (4, 'ADMIN',   'SYSTEM ADMINISTRATOR', 'ADMIN',           'STUDENT_STATUS_UPDATE','HPU-CS-2023-884 / ROHIT VERMA',       'ACADEMIC_STATUS SET TO SUSPENDED AND ATTENDANCE PORTAL LOCKED',       '10.0.0.1', 'WARNING', '2026-10-02 15:40:00'),
  (5, 'TEACHER', 'PROF. R.S. THAKUR',    'F-CS-02',        'WORKSHEET_GRADED',     'WORKSHEET 01 / HPU-CS-2023-882',     'AWARDED 19.5 / 20 -- EXCELLENT PL/SQL TRIGGER LOGIC',                 '10.0.0.7', 'INFO',     '2026-10-01 16:20:00'),
  (6, 'TEACHER', 'PROF. R.S. THAKUR',    'F-CS-02',        'ATTENDANCE_PUNCH',     'CS-601 / 2026-10-02',                 '22 OF 24 PRESENT, 2 ABSENT, 1 LATE',                                  '10.0.0.7', 'INFO',     '2026-10-02 10:05:00'),
  (7, 'SYSTEM',  'POLICY ENGINE',        NULL,             'FACULTY_WARNING',      'PROF. R.S. THAKUR / F-CS-02',         '2 WORKSHEET SUBMISSIONS PENDING BEYOND GRADING DEADLINE 2026-10-05', '127.0.0.1', 'WARNING', '2026-10-04 06:00:00'),
  (8, 'SYSTEM',  'AUTH GUARD',           NULL,             'ACCESS_DENIED',        'POST /api/admin/update-student-status', 'STUDENT ROLE ATTEMPTED AN ADMIN-ONLY OPERATION -- REQUEST BLOCKED', '10.0.0.9', 'SECURITY','2026-10-03 18:22:00');
