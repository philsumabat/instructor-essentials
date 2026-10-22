/**
 * Embedded sample templates for offline and zero-CORS execution.
 * Allows the builder to boot instantly with zero network dependencies.
 */

const createInfoZone = (w, nameW, sidW, offerW, schedW, dateW, scoreW) => ({
  type: 'fields',
  id: 'info',
  label: '',
  w,
  fieldHeight: 7.5,
  fields: [
    { id: 'name', label: 'Name', role: 'name', row: 0, w: nameW },
    { id: 'sid', label: 'ID no.', role: 'student_id', digits: 8, row: 0, w: sidW },
    { id: 'offer', label: 'Offer No.', row: 1, w: offerW },
    { id: 'sched', label: 'Sched', row: 1, w: schedW },
    { id: 'date', label: 'Date', row: 1, w: dateW },
    { id: 'score', label: 'Score', role: 'score', row: 1, w: scoreW },
  ],
});

export const SAMPLE_TEMPLATES = {
  'exam-50': {
    id: 'bio101-midterm-50',
    title: 'Midterm Examination (50 MCQ + T/F + Short Answer)',
    paper: 'A4',
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones: [
      createInfoZone(186, 108, 75, 48, 52, 43, 40),
      {
        type: 'instructions',
        id: 'notes',
        w: 186,
        fontSize: 2.6,
        text: 'Write your 8-digit ID no. clearly in the boxes above. Part I & II: fill each bubble completely with a dark pencil or pen.\nPart III: print your answer clearly in block capital letters inside the answer box corresponding to each question number.',
      },
      {
        type: 'mcq',
        id: 'part1',
        label: 'Part I — Multiple Choice (1–50)',
        count: 50,
        choices: 'ABCDE',
        columns: 4,
        pointsPerItem: 1,
        w: 186,
      },
      {
        type: 'truefalse',
        id: 'part2',
        label: 'Part II — True / False (51–60)',
        count: 10,
        columns: 5,
        pointsPerItem: 1,
        w: 186,
      },
      {
        type: 'text',
        id: 'q61',
        label: '61',
        w: 91,
        boxHeight: 8,
        points: 2,
        charset: 'alpha',
      },
      {
        type: 'text',
        id: 'q62',
        inline: true,
        label: '62',
        w: 91,
        boxHeight: 8,
        points: 2,
        charset: 'alpha',
      },
    ],
  },

  'exam-100': {
    id: 'chem201-final-100',
    title: 'Final Examination (100 MCQ)',
    paper: 'Letter',
    bubble: { diameter: 4.0, pitchX: 5.4, pitchY: 5.0, groupEvery: 5, groupGap: 1.4 },
    zones: [
      createInfoZone(191.9, 112, 79.9, 50, 54, 45, 42.9),
      {
        type: 'mcq',
        id: 'items',
        label: 'Multiple Choice (1–100)',
        count: 100,
        choices: 'ABCD',
        columns: 5,
        pointsPerItem: 1,
        w: 191.9,
      },
    ],
  },

  'quiz-tf': {
    id: 'hist110-quiz-tf',
    title: 'Quiz (True / False & Short Answer)',
    paper: 'Folio',
    zones: [
      createInfoZone(191.9, 112, 77, 50, 54, 45, 40),
      {
        type: 'truefalse',
        id: 'tf',
        label: 'Part I — Simple True / False (1–20)',
        layout: 'half-left',
        count: 20,
        columns: 2,
        pointsPerItem: 1,
      },
      {
        type: 'modified_tf',
        id: 'mod_tf',
        label: 'Part II — Modified T/F (21–30)',
        layout: 'half-right',
        count: 10,
        columns: 1,
        correctionWidth: 42,
        pointsPerItem: 2,
      },
      {
        type: 'text',
        id: 's1',
        label: '31',
        w: 191.9,
        boxHeight: 12,
        points: 2,
        charset: 'digits',
      },
      {
        type: 'text',
        id: 's2',
        label: '32',
        w: 191.9,
        boxHeight: 32,
        points: 5,
        charset: 'any',
        multiline: true,
      },
    ],
  },

  'quiz-bonus': {
    id: 'quiz101-bonus-10',
    title: '10-Item Quiz + Bonus Identification',
    paper: 'A4',
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones: [
      createInfoZone(186, 108, 75, 48, 52, 43, 40),
      {
        type: 'instructions',
        id: 'notes',
        w: 186,
        fontSize: 2.6,
        text: 'Part I (Items 1–10): Fill each bubble completely with a dark pencil or pen.\nPart II (Bonus): Print your identification answer clearly in block capital letters inside the answer box.',
      },
      {
        type: 'mcq',
        id: 'part1',
        label: 'Part I — Multiple Choice (1–10)',
        count: 10,
        choices: 'ABCD',
        columns: 2,
        pointsPerItem: 1,
        w: 186,
      },
      {
        type: 'text',
        id: 'bonus',
        label: 'Part II — Bonus Identification Question (5 pts)',
        w: 186,
        boxHeight: 18,
        points: 5,
        charset: 'alpha',
      },
    ],
  },
  blank: {
    id: 'blank',
    title: 'New Exam Sheet',
    paper: 'Folio',
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones: [],
  },
};

