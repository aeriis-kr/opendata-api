import React, { useState, useEffect } from 'react';
import SearchBar from './components/SearchBar';
import SearchResults from './components/SearchResults';
import DocumentDetail from './components/DocumentDetail';
import './App.css';

function App() {
  const [view, setView] = useState('search'); // 'search', 'results', 'detail'
  const [searchResults, setSearchResults] = useState(null);
  const [documentDetail, setDocumentDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // window.openai.toolOutput에서 초기 데이터 로드
    if (window.openai?.toolOutput) {
      const { searchResults: sr, documentDetail: dd } = window.openai.toolOutput;
      if (sr) {
        setSearchResults(sr);
        setView('results');
      }
      if (dd) {
        setDocumentDetail(dd);
        setView('detail');
      }
    }

    // openai:set_globals 이벤트 리스너
    const handleSetGlobals = (event) => {
      const globals = event.detail?.globals;
      if (!globals?.toolOutput) return;

      const { searchResults: sr, documentDetail: dd } = globals.toolOutput;
      if (sr) {
        setSearchResults(sr);
        setView('results');
        setLoading(false);
      }
      if (dd) {
        setDocumentDetail(dd);
        setView('detail');
        setLoading(false);
      }
    };

    window.addEventListener('openai:set_globals', handleSetGlobals, { passive: true });

    return () => {
      window.removeEventListener('openai:set_globals', handleSetGlobals);
    };
  }, []);

  const handleSearch = async (query, page = 1) => {
    setLoading(true);
    
    if (window.openai?.callTool) {
      try {
        const response = await window.openai.callTool('search_opendata', {
          query,
          page,
          pageSize: 10
        });
        
        if (response?.structuredContent?.searchResults) {
          setSearchResults(response.structuredContent.searchResults);
          setView('results');
        }
      } catch (error) {
        console.error('Search error:', error);
      } finally {
        setLoading(false);
      }
    } else {
      // 로컬 개발 모드 (ChatGPT 외부)
      console.log('Search:', query, page);
      setLoading(false);
    }
  };

  const handleSelectDocument = async (listId) => {
    setLoading(true);
    
    if (window.openai?.callTool) {
      try {
        const response = await window.openai.callTool('get_document_detail', {
          listId
        });
        
        if (response?.structuredContent?.documentDetail) {
          setDocumentDetail(response.structuredContent.documentDetail);
          setView('detail');
        }
      } catch (error) {
        console.error('Document detail error:', error);
      } finally {
        setLoading(false);
      }
    } else {
      // 로컬 개발 모드
      console.log('Get document:', listId);
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (view === 'detail') {
      setView('results');
      setDocumentDetail(null);
    } else if (view === 'results') {
      setView('search');
      setSearchResults(null);
    }
  };

  return (
    <div className="app">
      {loading && (
        <div className="loading-overlay">
          <div className="spinner"></div>
        </div>
      )}

      {view === 'search' && (
        <SearchBar onSearch={handleSearch} />
      )}

      {view === 'results' && searchResults && (
        <SearchResults
          results={searchResults}
          onSelectDocument={handleSelectDocument}
          onBack={handleBack}
          onSearch={handleSearch}
        />
      )}

      {view === 'detail' && documentDetail && (
        <DocumentDetail
          document={documentDetail}
          onBack={handleBack}
          onSelectDocument={handleSelectDocument}
        />
      )}
    </div>
  );
}

export default App;
