/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx,html}',
    './src/renderer/**/*.{ts,html}',
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          750: '#1f2937',
          850: '#0f172a',
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
