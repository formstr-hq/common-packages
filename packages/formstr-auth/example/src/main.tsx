import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'

// Basic global styles for the demo
const GlobalStyles = () => (
  <style>{`
    body {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      background: #ffffffff;
      color: #000000ff;
    }
    * {
      box-sizing: inherit;
    }
  `}</style>
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalStyles />
    <App />
  </React.StrictMode>,
)
