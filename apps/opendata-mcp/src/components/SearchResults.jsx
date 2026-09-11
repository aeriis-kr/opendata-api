import React from 'react';
import './SearchResults.css';

function SearchResults({ results, onSelectDocument, onBack, onSearch }) {
  const { total, page, pageSize, results: items } = results;
  const totalPages = Math.ceil(total / pageSize);

  const handlePageChange = (newPage) => {
    if (newPage >= 1 && newPage <= totalPages) {
      const lastQuery = items[0]?.listTitle || '';
      onSearch(lastQuery, newPage);
    }
  };

  return (
    <div className="results-container">
      <button onClick={onBack} className="back-button">
        ← 뒤로 가기
      </button>

      <div className="results-header">
        <h2>검색 결과</h2>
        <p className="results-count">
          총 <strong>{total}</strong>개의 결과를 찾았습니다
        </p>
      </div>

      <div className="results-grid">
        {items.map((item) => (
          <div
            key={item.listId}
            className="result-card"
            onClick={() => onSelectDocument(item.listId)}
          >
            <div className="result-header">
              <span className={`data-type-badge ${item.dataType.toLowerCase()}`}>
                {item.dataType}
              </span>
              {item.score && (
                <span className="score">점수: {item.score.toFixed(2)}</span>
              )}
            </div>

            <h3 className="result-title">{item.listTitle}</h3>
            
            {item.orgNm && (
              <p className="result-org">{item.orgNm}</p>
            )}

            {item.detail?.description && (
              <p className="result-description">
                {item.detail.description.length > 150
                  ? item.detail.description.substring(0, 150) + '...'
                  : item.detail.description}
              </p>
            )}

            <div className="result-footer">
              <span className="result-id">ID: {item.listId}</span>
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 1}
            className="pagination-button"
          >
            이전
          </button>

          <div className="pagination-info">
            {page} / {totalPages}
          </div>

          <button
            onClick={() => handlePageChange(page + 1)}
            disabled={page === totalPages}
            className="pagination-button"
          >
            다음
          </button>
        </div>
      )}
    </div>
  );
}

export default SearchResults;
