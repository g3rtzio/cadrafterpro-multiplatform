import { TestBed } from '@angular/core/testing';
import { JoistTool } from './joist-tool';

describe('JoistTool', () => {
  let service: JoistTool;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(JoistTool);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
