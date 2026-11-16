import { TestBed } from '@angular/core/testing';
import { PdfFile } from './pdf-file';

describe('PdfFile', () => {
  let service: PdfFile;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PdfFile);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
