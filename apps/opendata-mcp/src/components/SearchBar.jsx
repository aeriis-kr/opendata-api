import React, { useState } from 'react';
import './SearchBar.css';

function SearchBar({ onSearch }) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmedQuery = query.trim();
    if (trimmedQuery) {
      onSearch(trimmedQuery);
    }
  };

  return (
    <div className="search-container">
      <div className="search-card">
        <h1>공공데이터 검색</h1>
        <p className="subtitle">한국 공공데이터포털의 API와 파일 데이터를 검색하세요</p>
        
        <form onSubmit={handleSubmit} className="search-form">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="검색어를 입력하세요 (예: 기상, 교통, 인구 등)"
            className="search-input"
            autoFocus
          />
          <button type="submit" className="search-button">
            검색
          </button>
        </form>

        <div className="search-tips">
          <h3>검색 팁</h3>
          <ul>
            <li>키워드를 입력하여 공공데이터를 검색할 수 있습니다</li>
            <li>여러 키워드로 검색하면 더 정확한 결과를 얻을 수 있습니다</li>
            <li>API와 파일 데이터 모두 검색 가능합니다</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default SearchBar;
