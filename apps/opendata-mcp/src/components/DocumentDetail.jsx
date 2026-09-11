import React from 'react';
import ReactMarkdown from 'react-markdown';
import './DocumentDetail.css';

function DocumentDetail({ document, onBack, onSelectDocument }) {
  const {
    listId,
    dataType,
    listTitle,
    detailUrl,
    description,
    orgNm,
    deptNm,
    isCharged,
    shareScopeNm,
    keywords,
    markdown,
    recommendations,
    generatedStatus,
    tokenCount,
    createdAt,
    updatedAt
  } = document;

  return (
    <div className="detail-container">
      <button onClick={onBack} className="back-button">
        ← 검색 결과로 돌아가기
      </button>

      <div className="detail-card">
        <div className="detail-header">
          <div className="detail-badges">
            <span className={`data-type-badge ${dataType.toLowerCase()}`}>
              {dataType}
            </span>
            {generatedStatus && (
              <span className="status-badge generated">문서 생성됨</span>
            )}
          </div>
          
          <h1 className="detail-title">{listTitle}</h1>
          
          {orgNm && (
            <p className="detail-org">
              {orgNm} {deptNm && `· ${deptNm}`}
            </p>
          )}
        </div>

        <div className="detail-info-grid">
          <div className="info-item">
            <span className="info-label">ID</span>
            <span className="info-value">{listId}</span>
          </div>
          
          {isCharged && (
            <div className="info-item">
              <span className="info-label">유료 여부</span>
              <span className="info-value">{isCharged}</span>
            </div>
          )}
          
          {shareScopeNm && (
            <div className="info-item">
              <span className="info-label">공개 범위</span>
              <span className="info-value">{shareScopeNm}</span>
            </div>
          )}
          
          {tokenCount > 0 && (
            <div className="info-item">
              <span className="info-label">토큰 수</span>
              <span className="info-value">{tokenCount.toLocaleString()}</span>
            </div>
          )}
        </div>

        {keywords && keywords.length > 0 && (
          <div className="detail-keywords">
            {keywords.map((keyword, idx) => (
              <span key={idx} className="keyword-tag">
                {keyword}
              </span>
            ))}
          </div>
        )}

        {description && (
          <div className="detail-section">
            <h2>설명</h2>
            <p className="detail-description">{description}</p>
          </div>
        )}

        {detailUrl && (
          <div className="detail-section">
            <a
              href={detailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="detail-link"
            >
              공공데이터포털에서 보기 →
            </a>
          </div>
        )}

        {markdown && (
          <div className="detail-section markdown-section">
            <h2>문서 내용</h2>
            <div className="markdown-content">
              <ReactMarkdown>{markdown}</ReactMarkdown>
            </div>
          </div>
        )}

        {recommendations && recommendations.length > 0 && (
          <div className="detail-section">
            <h2>추천 문서</h2>
            <div className="recommendations-grid">
              {recommendations.map((rec) => (
                <div
                  key={rec.listId}
                  className="recommendation-card"
                  onClick={() => onSelectDocument(rec.listId)}
                >
                  <div className="recommendation-header">
                    <span className={`data-type-badge ${rec.dataType.toLowerCase()}`}>
                      {rec.dataType}
                    </span>
                    {rec.similarityScore && (
                      <span className="similarity-score">
                        {(rec.similarityScore * 100).toFixed(0)}% 유사
                      </span>
                    )}
                  </div>
                  <h3 className="recommendation-title">{rec.listTitle}</h3>
                  {rec.orgNm && (
                    <p className="recommendation-org">{rec.orgNm}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {(createdAt || updatedAt) && (
          <div className="detail-footer">
            {createdAt && (
              <span className="detail-date">생성일: {new Date(createdAt).toLocaleDateString('ko-KR')}</span>
            )}
            {updatedAt && (
              <span className="detail-date">수정일: {new Date(updatedAt).toLocaleDateString('ko-KR')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default DocumentDetail;
